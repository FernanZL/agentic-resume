"""The critic: numbers checked against the documents in code, everything else judged by
the model. Flagged proposals go back to their writer, for at most MAX_ROUNDS checks in
all; whatever is still flagged then reaches the user marked, with unverifiable numbers
replaced by placeholders."""

import json

from langchain_core.messages import HumanMessage, SystemMessage
from pydantic import BaseModel

from agent.events import emit, step
from agent.llm import Models, structured
from agent.nodes.writers import NODES as WRITERS
from agent.prompts import prompt
from agent.schemas import Document, Proposal, ProposalStatus
from agent.state import AnalysisState
from agent.tools import ats
from agent.tools.fetch_url import untrusted

MAX_ROUNDS = 3  # the first check and two rewrites
UNCHECKED = "The critic gave no verdict on this one; check it yourself."
AGAIN = "Needs another pass."
REPLACED = (
    "Numbers we couldn't find in your documents were replaced with [X]: fill in the real ones."
)


class Verdict(BaseModel):
    proposal_id: str
    ok: bool
    issues: list[str] = []


class Verdicts(BaseModel):
    verdicts: list[Verdict]


def sources(state: AnalysisState) -> str:
    """Everything the candidate gave us: the only evidence a number can come from."""
    documents = state["documents"]
    return "\n".join([documents["resume"], documents.get("linkedin", ""), state["target"].notes])


def number_issues(proposal: Proposal, evidence: str) -> list[str]:
    unsupported = ats.unsupported_numbers(proposal.proposed, evidence)
    return [f"Numbers not found in your documents: {', '.join(unsupported)}"] if unsupported else []


def with_placeholders(proposal: Proposal, evidence: str) -> Proposal:
    """The proposal with every unsupported number replaced, whole token by whole token,
    by [X]."""
    text, replaced = ats.replace_unsupported_numbers(proposal.proposed, evidence)
    if not replaced:
        return proposal
    return proposal.model_copy(
        update={
            "proposed": text,
            "placeholders": ats.placeholders_in(text),
            "issues": [*proposal.issues, REPLACED],
        }
    )


def to_check(state: AnalysisState) -> dict[str, Proposal]:
    """The first round checks every proposal; later rounds only the rewritten ones."""
    proposals = {pid: p for pid, p in (state.get("proposals") or {}).items() if p}
    if not state.get("critique_rounds"):
        return proposals
    return {pid: proposals[pid] for pid in state.get("critique") or {} if pid in proposals}


async def judge(
    models: Models, state: AnalysisState, proposals: dict[str, Proposal]
) -> dict[str, list[str]]:
    """The model's issues per proposal id (only for the proposals asked about)."""
    if not proposals:
        return {}
    payload = [
        p.model_dump(include={"id", "document", "target", "original", "proposed"})
        for p in proposals.values()
    ]
    verdicts: Verdicts = await structured(models.critic, Verdicts).ainvoke(
        [
            SystemMessage(prompt("critic")),
            HumanMessage(untrusted(state["profile"].model_dump_json(), "original profile")),
            HumanMessage("Proposals to check:\n" + json.dumps(payload, ensure_ascii=False)),
        ]
    )
    issues = {pid: [UNCHECKED] for pid in proposals}  # no verdict is not a pass
    for verdict in verdicts.verdicts:
        if verdict.proposal_id in proposals:
            issues[verdict.proposal_id] = [] if verdict.ok else verdict.issues or [AGAIN]
    return {pid: found for pid, found in issues.items() if found}


def make_critic(models: Models):
    @step("critic")
    async def critic(state: AnalysisState) -> dict:
        rounds = state.get("critique_rounds", 0) + 1
        checking = to_check(state)
        evidence = sources(state)
        flagged = {pid: number_issues(p, evidence) for pid, p in checking.items()}
        for pid, issues in (await judge(models, state, checking)).items():
            flagged[pid] = [*flagged[pid], *issues]
        flagged = {pid: issues for pid, issues in flagged.items() if issues}
        last = rounds >= MAX_ROUNDS
        updates: dict[str, Proposal] = {}
        for pid, proposal in checking.items():
            if pid not in flagged:
                updates[pid] = proposal.model_copy(
                    update={"status": ProposalStatus.OK, "issues": []}
                )
                continue
            marked = proposal.model_copy(
                update={"status": ProposalStatus.FLAGGED, "issues": flagged[pid]}
            )
            updates[pid] = with_placeholders(marked, evidence) if last else marked
        emit(
            "critique",
            "critic",
            round=rounds,
            flagged_ids=sorted(flagged),
            final=last or not flagged,
        )
        return {
            "proposals": updates,
            "critique": {} if last else flagged,
            "critique_rounds": rounds,
        }

    return critic


def after_critic(state: AnalysisState) -> list[str] | str:
    """Back to the writers whose proposals are flagged, or on to the review."""
    flagged = state.get("critique") or {}
    writers = [
        WRITERS[doc] for doc in Document if any(pid.startswith(f"{doc.value}:") for pid in flagged)
    ]
    return writers or "review"
