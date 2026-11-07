"""The API's request and response bodies and the live events it streams. With
agent/schemas.py this is the contract the web app is built against."""

from datetime import datetime
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field

from agent.schemas import Decision, GapReport, Proposal, Report, TargetJob


class DocumentKind(StrEnum):
    RESUME = "resume"
    LINKEDIN = "linkedin"


class DocumentText(BaseModel):
    """A document pasted as text instead of uploaded."""

    kind: DocumentKind
    text: str = Field(min_length=50, max_length=60_000)


class DocumentCreated(BaseModel):
    document_id: str
    kind: DocumentKind
    characters: int
    preview: str = Field(description="The first few hundred characters, to confirm the parse")


class SessionCreate(BaseModel):
    resume_document_id: str
    linkedin_document_id: str = Field("", description="Empty when there is no LinkedIn export")
    target: TargetJob


class SessionStatus(StrEnum):
    IDLE = "idle"  # waiting for the user's next message
    RUNNING = "running"  # a run is working
    REVIEW = "review"  # paused for the user's decisions on the proposals
    INTERRUPTED = "interrupted"  # a run was cut off (restart, sleep); POST /resume continues it
    FAILED = "failed"  # the last run failed; send a message to try again


class RunAccepted(BaseModel):
    session_id: str
    run_id: str


class ChatMessage(BaseModel):
    id: str
    role: str = Field(description="'user' or 'assistant'")
    content: str


class MessageCreate(BaseModel):
    content: str = Field(min_length=1, max_length=8_000)


class ReviewSubmit(BaseModel):
    """A decision per proposal id; proposals left out count as rejected."""

    decisions: dict[str, Decision]


class SessionSnapshot(BaseModel):
    """Everything the web app needs to draw a session, after a reload or a run."""

    session_id: str
    status: SessionStatus
    created_at: datetime
    target: TargetJob
    has_linkedin: bool
    messages: list[ChatMessage]
    reports: dict[str, Report]
    gap: GapReport | None
    proposals: list[Proposal]
    decisions: dict[str, Decision]
    cost_usd: float
    last_event_id: int = Field(description="Open the event stream after this id")


class EventType(StrEnum):
    RUN_STARTED = "run_started"  # data: {kind}
    NODE_STARTED = "node_started"  # node: the step; data: {label}
    NODE_FINISHED = "node_finished"  # node; data: {label, seconds}
    TOOL_CALLED = "tool_called"  # node; data: {tool, summary}
    TOKEN = "token"  # noqa: S105  not a secret. node 'concierge'; data: {text} (a chunk of the reply being written)
    MESSAGE = "message"  # data: ChatMessage (a whole assistant reply)
    REPORT_READY = "report_ready"  # data: {kind, ok}; the report is read from the snapshot
    GAP_READY = "gap_ready"  # data: {score, keyword_coverage}; the report via the snapshot
    PROPOSALS_READY = "proposals_ready"  # data: {round, proposal_ids}; text via the snapshot
    CRITIQUE = "critique"  # data: {round, flagged_ids, final}
    REVIEW_REQUIRED = "review_required"  # data: {proposal_ids}
    RUN_COMPLETED = "run_completed"  # data: {status: SessionStatus}
    # data: {error}: budget_exceeded | model_error | invalid_model_output | internal_error
    RUN_FAILED = "run_failed"


class Event(BaseModel):
    """One live event. On the wire (text/event-stream): 'id: <id>', 'event: <type>',
    'data: <this model as JSON>'."""

    id: int
    session_id: str
    run_id: str
    type: EventType
    node: str = ""
    data: dict[str, Any] = {}
    at: datetime


class Health(BaseModel):
    status: str
    database: bool


class ApiError(BaseModel):
    detail: str
