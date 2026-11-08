"""The graphs' state. The analysis subgraph works on AnalysisState; the session graph
extends it, so the keys they share can never drift apart. The checkpoint is the only
store of agent output: reports and proposals are read back from it, never copied."""

import operator
from dataclasses import dataclass
from typing import Annotated, Any, TypedDict

from langchain_core.messages import AnyMessage
from langgraph.graph.message import add_messages

from agent.schemas import (
    CandidateProfile,
    Decision,
    GapReport,
    LinkedInProfile,
    Proposal,
    Report,
    TargetJob,
)


def merge(current: dict[str, Any] | None, update: dict[str, Any] | None) -> dict[str, Any]:
    """Merge a dict update into a dict, key by key: parallel branches each add their own
    key, a rewrite replaces the value under the same key, and None removes the key."""
    merged = dict(current or {})
    for key, value in (update or {}).items():
        if value is None:
            merged.pop(key, None)
        else:
            merged[key] = value
    return merged


class Documents(TypedDict):
    """The text of the user's documents, as uploaded (the intake node parses it)."""

    resume: str
    linkedin: str


class AnalysisState(TypedDict, total=False):
    documents: Documents
    target: TargetJob
    profile: CandidateProfile
    linkedin: LinkedInProfile | None
    unsafe: str  # why intake found instructions hidden in the documents, or ""
    section_warnings: list[str]
    reports: Annotated[dict[str, Report], merge]
    gap: GapReport | None
    keyword_evidence: dict[str, str]  # missing terms -> exact candidate evidence
    proposals: Annotated[dict[str, Proposal | None], merge]
    critique: dict[str, list[str]]  # proposal id -> issues, from the last critic round
    critique_rounds: int
    decisions: Annotated[dict[str, Decision], merge]
    analyzed: bool  # finalize has run: there is something to export


class SessionState(AnalysisState, total=False):
    messages: Annotated[list[AnyMessage], add_messages]
    model_calls: Annotated[int, operator.add]
    route: str | None
    analysis_started: bool


@dataclass(frozen=True)
class RunContext:
    """Per-run ids, passed as the graph's context; tools and nodes read them, the model
    never supplies them."""

    session_id: str
    run_id: str
