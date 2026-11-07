"""The concierge: the chat agent the user talks to. It decides when to analyze, explains
the results and revises single proposals. Its state-changing tools return Commands,
so routing into the analysis subgraph happens in code, not in another model call."""

import json
from typing import Annotated, Literal

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import BaseTool, InjectedToolCallId, tool
from langgraph.prebuilt import InjectedState
from langgraph.types import Command, Overwrite

from agent.events import emit, step
from agent.llm import Models, structured
from agent.nodes.critic import judge, number_issues, sources, with_placeholders
from agent.nodes.writers import NODES as WRITERS
from agent.nodes.writers import Draft, to_proposals
from agent.prompts import prompt
from agent.schemas import Action, Decision, ProposalStatus
from agent.state import SessionState
from agent.tools.fetch_url import untrusted

# The most model calls the concierge makes for one user message.
MAX_CALLS_PER_TURN = 6
STOPPED = (
    "I've done as much as I can for this message. Tell me what you'd like next, "
    "and I'll pick it up from here."
)
# Added to the concierge's call (not the history) on its first turn after the analysis.
# Without it the model answers the last message it sees, "Analysis started", as if the
# analysis were still to come.
ANALYSIS_DONE = (
    "The analysis has finished and the user has reviewed the proposals (see the status). "
    "Tell them the outcome in a few lines: the match score, the main gaps, and that they "
    "can export the reviewed documents now."
)


def analysis_just_finished(state: SessionState) -> bool:
    """The concierge is back from the analysis: request_analysis's result is the last
    message, and the analysis is done (not a later tool's result)."""
    messages = state.get("messages") or []
    last = messages[-1] if messages else None
    return bool(
        state.get("analyzed") and isinstance(last, ToolMessage) and last.name == "request_analysis"
    )


def from_user(field: str, value: str, state: SessionState) -> str:
    """A posting field the model filled in, kept only if the user gave it: already known,
    or written in the chat. Models fill such fields with placeholders ("[the posting]"),
    which would replace the posting the user pasted in the form."""
    target = state.get("target")
    if not value or (target and value == getattr(target, field)):
        return value
    said = " ".join(m.text for m in state.get("messages") or [] if isinstance(m, HumanMessage))
    return value if " ".join(value.split()) in " ".join(said.split()) else ""


def status(state: SessionState) -> str:
    """What the concierge knows, as a few lines for its prompt."""
    target = state.get("target")
    documents = state.get("documents") or {}
    lines = [
        f"- Target: {target.model_dump_json(exclude={'job_text'}) if target else 'not set'}",
        f"- Posting text given: {'yes' if target and target.job_text else 'no'}",
        f"- LinkedIn profile given: {'yes' if documents.get('linkedin') else 'no'}",
    ]
    if state.get("unsafe"):
        lines.append(
            f"- Warning: the documents contained hidden instructions ({state['unsafe']}); "
            "they were ignored. Tell the user."
        )
    lines += _analysis_status(state)
    return "\n".join(lines)


def _analysis_status(state: SessionState) -> list[str]:
    reports = state.get("reports") or {}
    if not reports:
        return ["- Analysis: not run yet."]
    lines = [f"- Research done: {', '.join(sorted(reports))}"]
    lines += [f"- {kind} research failed: {r.error}" for kind, r in reports.items() if r.error]
    if gap := state.get("gap"):
        lines.append(
            f"- Match score {gap.score}/100, keyword coverage {gap.keyword_coverage:.0%}, "
            f"missing: {', '.join(gap.missing_keywords[:8]) or 'none'}"
        )
    proposals = [p for p in (state.get("proposals") or {}).values() if p]
    flagged = sum(p.status is ProposalStatus.FLAGGED for p in proposals)
    lines.append(f"- Proposals: {len(proposals)} ({flagged} still flagged by the critic)")
    decisions = state.get("decisions") or {}
    if state.get("analyzed"):
        counts = {a.value: sum(d.action is a for d in decisions.values()) for a in Action}
        lines.append(f"- Review done: {counts}. The user can export now.")
    return lines


def make_tools(models: Models) -> list[BaseTool]:
    """The concierge's tools, closed over the models revise_proposal needs."""

    @tool
    def request_analysis(
        title: str,
        state: Annotated[dict, InjectedState],
        tool_call_id: Annotated[str, InjectedToolCallId],
        company: str = "",
        job_url: str = "",
        job_text: str = "",
        notes: str = "",
    ) -> Command:
        """Run the full analysis for this target role. Leave a field empty to keep what is
        already known. job_url and job_text only when the user wrote them in this chat,
        copied exactly. Starts the research team; previous results are replaced."""
        update = {
            "title": title,
            "company": company,
            "job_url": from_user("job_url", job_url, state),
            "job_text": from_user("job_text", job_text, state),
            "notes": notes,
        }
        target = state["target"].model_copy(update={k: v for k, v in update.items() if v})
        return Command(
            update={
                "route": "analyze",
                "target": target,
                "reports": Overwrite({}),
                "proposals": Overwrite({}),
                "decisions": Overwrite({}),
                "critique": {},
                "critique_rounds": 0,
                "gap": None,
                "analyzed": False,
                "messages": [
                    ToolMessage(
                        f"Analysis started for {target.title}.",
                        name="request_analysis",
                        tool_call_id=tool_call_id,
                    )
                ],
            }
        )

    @tool
    def get_report(
        kind: Literal["job", "company", "market", "linkedin", "gap"],
        state: Annotated[dict, InjectedState],
    ) -> str:
        """Read one research report, or the gap analysis, in full."""
        found = state.get("gap") if kind == "gap" else (state.get("reports") or {}).get(kind)
        return found.model_dump_json(exclude_none=True) if found else f"No {kind} report yet."

    @tool
    def explain_proposal(proposal_id: str, state: Annotated[dict, InjectedState]) -> str:
        """Read one proposal in full, with the critic's issues and the user's decision."""
        proposal = (state.get("proposals") or {}).get(proposal_id)
        if not proposal:
            return "There is no such proposal. Ids look like 'resume:exp0.b1' or 'linkedin:about'."
        decision = (state.get("decisions") or {}).get(proposal_id)
        return json.dumps(
            {
                "proposal": proposal.model_dump(mode="json"),
                "decision": decision.model_dump(mode="json") if decision else None,
            }
        )

    @tool
    async def revise_proposal(
        proposal_id: str,
        instruction: str,
        state: Annotated[dict, InjectedState],
        tool_call_id: Annotated[str, InjectedToolCallId],
    ) -> Command | str:
        """Rewrite one proposal following the user's instruction (after the review). The
        new version is fact-checked and becomes the accepted text."""
        proposal = (state.get("proposals") or {}).get(proposal_id)
        if not proposal:
            return "There is no such proposal."
        if not state.get("analyzed"):
            return "The review is still open: the user decides in the review panel first."
        emit("tool_called", "concierge", tool="revise_proposal", summary=proposal_id)
        draft: Draft = await structured(models.writer, Draft).ainvoke(
            [
                SystemMessage(prompt(WRITERS[proposal.document])),
                HumanMessage(untrusted(state["profile"].model_dump_json(), "resume (structured)")),
                HumanMessage(
                    json.dumps(
                        {"current": proposal.model_dump(mode="json"), "instruction": instruction},
                        ensure_ascii=False,
                    )
                    + f"\nReturn exactly one proposal with target '{proposal.target}'."
                ),
            ]
        )
        draft.target = proposal.target
        revised = to_proposals(proposal.document, [draft], state).get(proposal_id)
        if not revised:
            return "The rewrite came out the same as the original; nothing changed."
        evidence = sources(state)
        issues = number_issues(revised, evidence)
        issues += (await judge(models, state, {proposal_id: revised})).get(proposal_id, [])
        if issues:
            revised = with_placeholders(
                revised.model_copy(update={"status": ProposalStatus.FLAGGED, "issues": issues}),
                evidence,
            )
        return Command(
            update={
                "proposals": {proposal_id: revised},
                "decisions": {proposal_id: Decision(action=Action.ACCEPT)},
                "messages": [
                    ToolMessage(
                        json.dumps({"revised": revised.proposed, "issues": issues}),
                        tool_call_id=tool_call_id,
                    )
                ],
            }
        )

    return [request_analysis, get_report, explain_proposal, revise_proposal]


def calls_this_turn(state: SessionState) -> int:
    """The concierge's replies since the user's last message."""
    count = 0
    for message in reversed(state.get("messages") or []):
        if isinstance(message, HumanMessage):
            break
        count += isinstance(message, AIMessage)
    return count


def make_concierge(models: Models, tools: list[BaseTool]):
    bound = models.concierge.bind_tools(tools)

    @step("concierge")
    async def concierge(state: SessionState) -> dict:
        if calls_this_turn(state) >= MAX_CALLS_PER_TURN:
            reply = AIMessage(STOPPED)
        else:
            system = SystemMessage(prompt("concierge").format(status=status(state)))
            messages = [system, *state["messages"]]
            if analysis_just_finished(state):
                messages.append(SystemMessage(ANALYSIS_DONE))
            reply = await bound.ainvoke(messages)
        if reply.text and not reply.tool_calls:
            emit("message", "concierge", id=reply.id or "", role="assistant", content=reply.text)
        return {"messages": [reply], "route": None, "model_calls": 1}

    return concierge
