"""The review: the run pauses until the user decides on each proposal, which is the only
way to export. Finalize then marks the analysis as done; documents are rendered from
the proposals and decisions on demand, so later revisions always show."""

from langgraph.types import interrupt

from agent.events import LABELS, emit, step
from agent.schemas import Decision
from agent.state import AnalysisState


def resume_with(decisions: dict) -> dict:
    """What the review is resumed with. It is never empty: LangGraph can't resume with
    an empty value."""
    return {"decisions": decisions}


def parse_decisions(answer: object, proposal_ids: set[str]) -> dict[str, Decision]:
    """The user's decisions, keeping only those for proposals that exist."""
    decisions = answer.get("decisions") if isinstance(answer, dict) else None
    if not isinstance(decisions, dict):
        return {}
    return {
        pid: Decision.model_validate(value)
        for pid, value in decisions.items()
        if pid in proposal_ids
    }


async def review(state: AnalysisState) -> dict:
    """Pause for the user's decisions (the pause is skipped when nothing was proposed)."""
    ids = sorted(pid for pid, p in (state.get("proposals") or {}).items() if p)
    if not ids:
        return {}
    answer = interrupt({"proposal_ids": ids})
    emit("node_finished", "review", label=LABELS["review"], seconds=0)
    return {"decisions": parse_decisions(answer, set(ids))}


@step("finalize")
async def finalize(state: AnalysisState) -> dict:
    return {"analyzed": True}
