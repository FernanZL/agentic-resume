"""The researchers: the plan that picks them, and one bounded tool loop each, run in
parallel through Send. Each keeps its own private messages and writes only its report."""

import json
import re
import time
from urllib.parse import urlsplit

import httpx
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import BaseTool
from langgraph.types import RetryPolicy, Send
from openrouter import errors as openrouter_errors
from pydantic import BaseModel

from agent.events import emit, step
from agent.linkedin_guidance import candidate_urls
from agent.llm import Models, StopRun, structured
from agent.prompts import prompt
from agent.schemas import (
    CompanyBrief,
    JobAnalysis,
    LinkedInAudit,
    MarketBrief,
    Report,
    ReportKind,
    Source,
)
from agent.state import AnalysisState
from agent.toolbox import Toolbox
from agent.tools.fetch_url import untrusted
from agent.tools.linkedin import profile_url

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
# Failures worth another attempt (the SDK itself retries 5XX only); anything else
# becomes an error in the report.
RETRY = RetryPolicy(
    max_attempts=3,
    initial_interval=2.0,
    retry_on=(
        openrouter_errors.TooManyRequestsResponseError,
        openrouter_errors.ProviderOverloadedResponseError,
        openrouter_errors.RequestTimeoutResponseError,
        openrouter_errors.EdgeNetworkTimeoutResponseError,
        openrouter_errors.NoResponseError,
        httpx.TimeoutException,
        httpx.NetworkError,
    ),
)


def plan(state: AnalysisState) -> list[Send]:
    """Plan research from the target, supplied LinkedIn text or an exact public profile URL."""
    kinds = [ReportKind.JOB, ReportKind.MARKET]
    if state["target"].company:
        kinds.append(ReportKind.COMPANY)
    kinds.append(ReportKind.LINKEDIN)
    return [Send(NODES[kind], state) for kind in kinds]


def supplied_linkedin_url(state: AnalysisState) -> str:
    """Find a profile URL in supplied documents or the candidate's target notes."""
    documents = state.get("documents") or {}
    return profile_url(
        "\n".join(
            [
                documents.get("linkedin", ""),
                documents.get("resume", ""),
                state["target"].notes,
            ]
        )
    )


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


async def public_linkedin(state: AnalysisState, toolbox: Toolbox) -> str:
    """Fetch the exact supplied profile without placing its URL in event logs."""
    if toolbox.linkedin_search is None:
        return "Unavailable: LinkedIn search is not configured. Upload or paste your profile."
    emit(
        "tool_called", "linkedin_auditor", tool="linkedin_profile_search", summary="Public profile"
    )
    try:
        return await toolbox.linkedin_search.ainvoke({"url": supplied_linkedin_url(state)})
    except StopRun:
        raise
    except Exception as error:  # noqa: BLE001  preparation remains useful when retrieval fails
        return (
            f"Unavailable: public retrieval failed ({type(error).__name__}). "
            "Use resume-based preparation."
        )


async def _research(
    kind: ReportKind, state: AnalysisState, models: Models, toolbox: Toolbox, node: str
) -> BaseModel:
    schema = SCHEMAS[kind]
    if kind is ReportKind.LINKEDIN:
        return await linkedin_research(state, models, toolbox)
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
        "public_linkedin": state.get("public_linkedin", ""),
        "resume": profile.model_dump(),
        "supplementary_sources": state.get("supplementary_sources", ""),
    }
    return await structured(models.analyst, LinkedInAudit).ainvoke(
        [
            SystemMessage(prompt("linkedin_auditor")),
            HumanMessage(untrusted(json.dumps(content, ensure_ascii=False), "candidate documents")),
        ]
    )


async def linkedin_research(
    state: AnalysisState, models: Models, toolbox: Toolbox
) -> LinkedInAudit:
    """Audit available profile content, otherwise prepare from supplied facts and sources."""
    if state.get("linkedin"):
        audit = await _audit_linkedin(state, models)
        return audit.model_copy(update={"basis": "profile", "retrieval_status": "available"})
    public = ""
    limitations = []
    url = supplied_linkedin_url(state)
    if url:
        public = await public_linkedin(state, toolbox)
        if public.startswith("Unavailable:"):
            limitations.append(public)
            public = ""
    if public:
        audit = await safe_preparation(
            {**state, "public_linkedin": public},
            models,
            basis="public",
            sources=[Source(url=url)],
            limitations=[
                "Public search content may be partial or out of date. "
                "Confirm it against your profile.",
            ],
        )
        return audit.model_copy(update={"retrieval_status": "available"})
    supplements, sources = await supplied_sources(state, toolbox)
    guidance, guidance_sources = await research_guidance(state, toolbox)
    supplements = "\n\n".join(part for part in (supplements, guidance) if part)
    sources += guidance_sources
    limitations.append(
        "The current LinkedIn profile was not inspected. This is preparation based on your resume."
    )
    if supplements:
        audit = await safe_preparation(
            {**state, "supplementary_sources": supplements},
            models,
            basis="resume_only",
            sources=sources,
            limitations=limitations,
        )
    else:
        audit = static_preparation(limitations, sources)
    status = retrieval_status(limitations[0]) if url else "not_requested"
    return audit.model_copy(update={"retrieval_status": status})


def retrieval_status(reason: str) -> str:
    """Distinguish a missing key or failed tool from unavailable public input."""
    if "not configured" in reason.lower():
        return "not_configured"
    return "failed" if "failed" in reason.lower() else "unavailable"


def static_preparation(limitations: list[str], sources: list[Source]) -> LinkedInAudit:
    """Keep resume-based preparation available even if a supplementary model response fails."""
    return LinkedInAudit(
        summary=(
            "Prepare your LinkedIn headline, About, skills and entry descriptions "
            "from your resume and target-role research."
        ),
        basis="resume_only",
        limitations=limitations,
        sources=sources,
        headline_issues=["Use a truthful role focus and supported specialisms."],
        about_issues=["Explain your experience, project evidence and target in short paragraphs."],
    )


async def safe_preparation(state, models, basis, sources, limitations) -> LinkedInAudit:
    """Never discard fallback preparation because a supplementary audit output is malformed."""
    try:
        audit = await _audit_linkedin(state, models)
    except StopRun:
        raise
    except Exception as error:  # noqa: BLE001  preserve the useful fallback without leaking input
        return static_preparation(
            [*limitations, f"Supplementary audit unavailable ({type(error).__name__})."], sources
        )
    return audit.model_copy(update={"basis": basis, "sources": sources, "limitations": limitations})


async def supplied_sources(state: AnalysisState, toolbox: Toolbox) -> tuple[str, list[Source]]:
    """Fetch at most two supplied portfolio/repository pages as unconfirmed supporting context."""
    raw = "\n".join((state.get("documents") or {}).values())
    blocks, sources = [], []
    for url in candidate_urls(state["profile"]):
        if url not in raw:
            continue
        emit(
            "tool_called",
            "linkedin_auditor",
            tool="fetch_url",
            summary="Supplied portfolio/repository",
        )
        try:
            fetched = await toolbox.fetch(url)
        except (StopRun, *RETRY.retry_on):
            raise
        except Exception:  # noqa: BLE001, S112  unavailable context never blocks preparation
            continue
        if fetched.ok:
            blocks.append(untrusted(fetched.text, url))
            sources.append(Source(url=url, title=fetched.title))
    return "\n\n".join(blocks), sources


async def research_guidance(state: AnalysisState, toolbox: Toolbox) -> tuple[str, list[Source]]:
    """Use one bounded search for official guidance when a current profile is unavailable."""
    key = "2026-11-08:" + state["target"].title.strip().casefold()
    cached = toolbox.guidance_cache.get(key)
    if cached and time.monotonic() - cached[0] < 86_400:
        return cached[1], cached[2]
    content, sources = await fresh_guidance(state, toolbox)
    if len(toolbox.guidance_cache) >= 64:
        toolbox.guidance_cache.pop(next(iter(toolbox.guidance_cache)))
    toolbox.guidance_cache[key] = (time.monotonic(), content, sources)
    return content, sources


async def fresh_guidance(state: AnalysisState, toolbox: Toolbox) -> tuple[str, list[Source]]:
    """Search and filter one batch, caching misses as well as successful source retrieval."""
    emit("tool_called", "linkedin_auditor", tool="web_search", summary="Official profile guidance")
    query = (
        "site:linkedin.com/help/linkedin edit profile headline about skills "
        + state["target"].title
    )
    try:
        content = str(await toolbox.web_search.ainvoke({"query": query}))
    except StopRun:
        raise
    except Exception:  # noqa: BLE001  missing guidance must not block resume-based preparation
        return "", []
    sources, blocks = [], []
    for block in re.split(r"(?=<untrusted_content source=)", content):
        found = re.search(r"^URL:\s*(https?://[^\s<>\"]+)", block, re.M)
        if not found:
            continue
        url = found.group(1)
        parts = urlsplit(url)
        if parts.hostname in {"linkedin.com", "www.linkedin.com"} and parts.path.startswith(
            "/help/"
        ):
            sources.append(Source(url=url, title="LinkedIn Help"))
            blocks.append(block)
    if not sources:
        return "", []
    # Treat search output as untrusted guidance, never candidate evidence or verified field limits.
    return untrusted(
        "\n\n".join(blocks)[:8_000], "official guidance; verify in the editor"
    ), sources[:3]
