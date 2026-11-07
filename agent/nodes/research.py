"""The researchers: the plan that picks them, and one bounded tool loop each, run in
parallel through Send. Each keeps its own private messages and writes only its report."""

import json

import httpx
import openai
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import BaseTool
from langgraph.types import RetryPolicy, Send
from pydantic import BaseModel

from agent.events import emit, step
from agent.llm import Models, StopRun, structured
from agent.prompts import prompt
from agent.schemas import (
    CompanyBrief,
    JobAnalysis,
    LinkedInAudit,
    MarketBrief,
    Report,
    ReportKind,
)
from agent.state import AnalysisState
from agent.toolbox import Toolbox
from agent.tools.fetch_url import untrusted

MAX_TOOL_CALLS = 4
NODES = {
    ReportKind.JOB: "job_analyst",
    ReportKind.COMPANY: "company_researcher",
    ReportKind.MARKET: "market_analyst",
    ReportKind.LINKEDIN: "linkedin_auditor",
}
GOALS = {
    ReportKind.JOB: (
        "work out exactly what this role asks for: must-have and nice-to-have skills, "
        "seniority, responsibilities, and the exact keywords an ATS would match on."
    ),
    ReportKind.COMPANY: (
        "brief the writers on the company: what it builds, its stack, its values and the "
        "tone it uses, and recent news worth knowing."
    ),
    ReportKind.MARKET: (
        "describe how the market names and values this kind of role: common title "
        "variants, adjacent in-demand skills, and what signals the level."
    ),
}
SCHEMAS: dict[ReportKind, type[BaseModel]] = {
    ReportKind.JOB: JobAnalysis,
    ReportKind.COMPANY: CompanyBrief,
    ReportKind.MARKET: MarketBrief,
    ReportKind.LINKEDIN: LinkedInAudit,
}
# Failures worth another attempt; anything else becomes an error in the report.
RETRY = RetryPolicy(
    max_attempts=3,
    initial_interval=2.0,
    retry_on=(
        openai.RateLimitError,
        openai.APITimeoutError,
        openai.APIConnectionError,
        httpx.TimeoutException,
    ),
)


def plan(state: AnalysisState) -> list[Send]:
    """The researchers this run needs: no company research without a company, no
    LinkedIn audit without a LinkedIn profile."""
    kinds = [ReportKind.JOB, ReportKind.MARKET]
    if state["target"].company:
        kinds.append(ReportKind.COMPANY)
    if state.get("linkedin"):
        kinds.append(ReportKind.LINKEDIN)
    return [Send(NODES[kind], state) for kind in kinds]


async def investigate(
    model: BaseChatModel,
    tools: list[BaseTool],
    messages: list[BaseMessage],
    node: str,
    max_calls: int = MAX_TOOL_CALLS,
) -> list[BaseMessage]:
    """Let the model call tools until it stops or reaches max_calls; every call it asks
    for gets an answer, as the API requires."""
    by_name = {tool.name: tool for tool in tools}
    bound = model.bind_tools(tools)
    calls = 0
    while calls < max_calls:
        reply = await bound.ainvoke(messages)
        messages.append(reply)
        if not getattr(reply, "tool_calls", None):
            break
        for call in reply.tool_calls:
            calls += 1
            if calls > max_calls:  # answered, as the API requires, but not run
                result = "Tool limit reached: answer with what you have."
            else:
                emit("tool_called", node, tool=call["name"], summary=_summary(call["args"]))
                result = await _run(by_name.get(call["name"]), call["args"])
            messages.append(ToolMessage(result, tool_call_id=call["id"]))
    return messages


async def _run(tool: BaseTool | None, args: dict) -> str:
    if tool is None:
        return "There is no such tool."
    try:
        return str(await tool.ainvoke(args))
    except Exception as error:  # noqa: BLE001  a failing tool is reported to the model
        return f"The tool failed: {error}"


def _summary(args: dict) -> str:
    text = " ".join(str(value) for value in args.values())
    return text[:120]


def _brief(state: AnalysisState) -> str:
    """What every researcher is told about the task."""
    target = state["target"]
    lines = [f"Target role: {target.title}"]
    if target.company:
        lines.append(f"Company: {target.company}")
    if target.notes:
        lines.append(f"Notes from the candidate: {target.notes}")
    if target.job_url:
        lines.append(f"Posting URL: {target.job_url}")
    return "\n".join(lines)


def make_researcher(kind: ReportKind, models: Models, toolbox: Toolbox):
    """The node for one kind of research."""
    node = NODES[kind]

    @step(node)
    async def research(state: AnalysisState) -> dict:
        try:
            body = await _research(kind, state, models, toolbox, node)
        except (StopRun, *RETRY.retry_on):  # the run ends, or the retry policy handles it
            raise
        except Exception as error:  # noqa: BLE001  one failed researcher doesn't end the run
            # Only the type: the message may quote the documents, and the report is shown.
            report = Report(kind=kind, error=f"This research failed ({type(error).__name__}).")
        else:
            report = Report(kind=kind, **{kind.value: body})
        emit("report_ready", node, kind=kind.value, ok=not report.error)
        return {"reports": {kind.value: report}}

    return research


async def _research(
    kind: ReportKind, state: AnalysisState, models: Models, toolbox: Toolbox, node: str
) -> BaseModel:
    schema = SCHEMAS[kind]
    if kind is ReportKind.LINKEDIN:
        return await _audit_linkedin(state, models)
    tools = [toolbox.web_search, toolbox.fetch_url]
    task = [_brief(state)]
    if kind is ReportKind.JOB:
        task.append(await _posting(state, toolbox, node))
    system = prompt("researcher").format(
        kind=kind.value, goal=GOALS[kind], max_calls=MAX_TOOL_CALLS
    )
    messages: list[BaseMessage] = [SystemMessage(system), HumanMessage("\n\n".join(task))]
    messages = await investigate(models.researcher, tools, messages, node)
    messages.append(HumanMessage("Now give your final answer, with sources."))
    return await structured(models.researcher, schema).ainvoke(messages)


async def _posting(state: AnalysisState, toolbox: Toolbox, node: str) -> str:
    """The posting's text: pasted by the user, or fetched in code from its URL."""
    target = state["target"]
    if target.job_text:
        return untrusted(target.job_text, "job posting (pasted)")
    if target.job_url:
        emit("tool_called", node, tool="fetch_url", summary=target.job_url[:120])
        fetched = await toolbox.fetch(target.job_url)
        if fetched.ok:
            return untrusted(fetched.text, target.job_url)
        return f"The posting could not be fetched ({fetched.error}). Research the role instead."
    return "No posting was given: infer the requirements from the role and the market."


async def _audit_linkedin(state: AnalysisState, models: Models) -> LinkedInAudit:
    linkedin, profile = state["linkedin"], state["profile"]
    content = {
        "target": state["target"].model_dump(),
        "linkedin": linkedin.model_dump() if linkedin else None,
        "resume": profile.model_dump(),
    }
    return await structured(models.analyst, LinkedInAudit).ainvoke(
        [
            SystemMessage(prompt("linkedin_auditor")),
            HumanMessage(untrusted(json.dumps(content, ensure_ascii=False), "candidate documents")),
        ]
    )
