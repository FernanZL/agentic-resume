"""The writers: one call each over the whole document, so the voice stays coherent.
Code gives each proposal its id, its original text and its placeholders, and drops
any that point at something that doesn't exist."""

import json

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import HumanMessage, SystemMessage
from pydantic import BaseModel, Field

from agent.events import emit, step
from agent.llm import Models, structured
from agent.prompts import prompt
from agent.render import original_of
from agent.schemas import Document, Proposal, ProposalStatus
from agent.state import AnalysisState
from agent.tools import ats
from agent.tools.fetch_url import untrusted

NODES = {Document.RESUME: "resume_writer", Document.LINKEDIN: "linkedin_writer"}


class Draft(BaseModel):
    target: str = Field(description="What it changes, as the instructions describe")
    proposed: str
    rationale: str = Field(description="Why, in one or two sentences, tied to the target role")
    keywords: list[str] = Field([], description="The role's keywords this text now covers")


class Drafts(BaseModel):
    proposals: list[Draft]


def proposal_id(document: Document, target: str) -> str:
    return f"{document.value}:{target}"


def feedback_for(document: Document, state: AnalysisState) -> dict[str, list[str]]:
    """The critic's open issues on this document's proposals."""
    prefix = f"{document.value}:"
    return {
        pid: issues
        for pid, issues in (state.get("critique") or {}).items()
        if pid.startswith(prefix)
    }


def _context(document: Document, state: AnalysisState) -> str:
    reports = {
        kind: report.model_dump(exclude_none=True)
        for kind, report in (state.get("reports") or {}).items()
    }
    gap = state.get("gap")
    context = {
        "target": state["target"].model_dump(),
        "gap": gap.model_dump() if gap else None,
        "research": reports,
    }
    return json.dumps(context, ensure_ascii=False)


def _documents(document: Document, state: AnalysisState) -> str:
    profile = untrusted(state["profile"].model_dump_json(), "resume (structured)")
    linkedin = state.get("linkedin")
    if document is Document.LINKEDIN and linkedin:
        return profile + "\n\n" + untrusted(linkedin.model_dump_json(), "linkedin (structured)")
    return profile


def _request(document: Document, state: AnalysisState) -> list:
    messages = [
        SystemMessage(prompt(NODES[document])),
        HumanMessage(_documents(document, state)),
        HumanMessage("Research and gap analysis:\n" + _context(document, state)),
    ]
    feedback = feedback_for(document, state)
    if feedback:
        current = {
            pid: state["proposals"][pid].proposed
            for pid in feedback
            if state.get("proposals", {}).get(pid)
        }
        messages.append(
            HumanMessage(
                "Critic feedback. Rewrite only these proposals, fixing these issues:\n"
                + json.dumps({"issues": feedback, "current": current}, ensure_ascii=False)
            )
        )
    return messages


def to_proposals(
    document: Document, drafts: list[Draft], state: AnalysisState
) -> dict[str, Proposal]:
    """The drafts as proposals; a draft whose target doesn't exist is dropped."""
    proposals: dict[str, Proposal] = {}
    for draft in drafts:
        target = draft.target.strip()
        original = original_of(target, document, state["profile"], state.get("linkedin"))
        if original is None or draft.proposed.strip() == (original or "").strip():
            continue
        pid = proposal_id(document, target)
        proposals[pid] = Proposal(
            id=pid,
            document=document,
            target=target,
            original=original,
            proposed=draft.proposed.strip(),
            rationale=draft.rationale,
            keywords=draft.keywords,
            placeholders=ats.placeholders_in(draft.proposed),
            status=ProposalStatus.OK,
        )
    return proposals


def withdrawn(document: Document, drafts: list[Draft], state: AnalysisState) -> set[str]:
    """Proposals a rewrite gave up on by returning the original text."""
    gone = set()
    for draft in drafts:
        target = draft.target.strip()
        original = original_of(target, document, state["profile"], state.get("linkedin"))
        if original is not None and draft.proposed.strip() == original.strip():
            gone.add(proposal_id(document, target))
    return gone


def make_writer(document: Document, models: Models):
    node = NODES[document]
    model: BaseChatModel = models.writer

    @step(node)
    async def write(state: AnalysisState) -> dict:
        drafts: Drafts = await structured(model, Drafts).ainvoke(_request(document, state))
        updates: dict[str, Proposal | None] = dict(to_proposals(document, drafts.proposals, state))
        if flagged := feedback_for(document, state):  # a rewrite answers only the flagged ones
            updates = {pid: p for pid, p in updates.items() if pid in flagged}
            updates |= dict.fromkeys(withdrawn(document, drafts.proposals, state) & flagged.keys())
        # Ids only: the text is read from the snapshot, never copied into the event log.
        emit(
            "proposals_ready",
            node,
            round=state.get("critique_rounds", 0) + 1,
            proposal_ids=sorted(pid for pid, p in updates.items() if p),
        )
        return {"proposals": updates}

    return write
