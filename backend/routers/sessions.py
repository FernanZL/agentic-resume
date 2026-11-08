"""Sessions: create one from documents and a target, chat, review, resume, export, and
the live event stream."""

from typing import Annotated, Literal

from fastapi import APIRouter, Header, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.types import Command, Overwrite

from agent.linkedin_guidance import guidance_for
from agent.nodes.critic import deterministic_issues
from agent.nodes.review import resume_with
from agent.nodes.writers import Draft, to_proposals
from agent.render import apply_decisions
from agent.revisions import review_revision
from agent.schemas import Decision, ProposalStatus
from backend import export
from backend.advisory import answer_question, current_history, session_claim
from backend.budget import BudgetExceeded
from backend.database import DocumentUnavailable, new_id
from backend.errors import error_code
from backend.events import event_stream
from backend.runner import RunActive
from backend.schemas import (
    AskRequest,
    AskResponse,
    ChatMessage,
    DocumentKind,
    MessageCreate,
    ReanalyzeRequest,
    ReviewSubmit,
    RunAccepted,
    SessionCreate,
    SessionSnapshot,
    SessionStatus,
)
from backend.services import Passcode, Services, Svc

router = APIRouter(prefix="/api/sessions", tags=["sessions"])
ANALYSIS_KEYS = ("profile", "linkedin", "reports", "gap", "proposals", "decisions")


def config(session_id: str) -> dict:
    return {"configurable": {"thread_id": session_id}}


async def session_row(svc: Services, session_id: str) -> dict:
    row = await svc.db.get_session(session_id)
    if not row:
        raise HTTPException(404, "session_not_found")
    return row


async def graph_values(svc: Services, session_id: str) -> dict:
    """The session's state, with the analysis subgraph's values while it is paused or
    working (they reach the parent only when the subgraph ends)."""
    state = await svc.runner.graph.aget_state(config(session_id), subgraphs=True)
    values = dict(state.values)
    for task in state.tasks:
        inner = getattr(task.state, "values", None)
        if task.name == "analysis" and inner:
            values.update({key: inner[key] for key in ANALYSIS_KEYS if key in inner})
    return values


async def start(svc: Services, session_id: str, kind: str, payload: object) -> RunAccepted:
    try:
        run_id = await svc.runner.start(session_id, kind, payload)
    except RunActive:
        raise HTTPException(409, "run_active") from None
    except BudgetExceeded:
        raise HTTPException(429, "budget_exceeded") from None
    return RunAccepted(session_id=session_id, run_id=run_id)


def intro(body: SessionCreate) -> str:
    """The user's first message, written for them from the form."""
    at = f" at {body.target.company}" if body.target.company else ""
    linkedin = " and my LinkedIn profile" if body.linkedin_document_id else ""
    return f"Hi! I've shared my resume{linkedin}. I'm aiming for {body.target.title}{at}."


@router.post("", status_code=202, dependencies=[Passcode], operation_id="create_session")
async def create_session(svc: Svc, body: SessionCreate) -> RunAccepted:
    """Create a session from uploaded documents and a target role, and start the chat."""
    try:
        await svc.budget.check()  # before any document is claimed
    except BudgetExceeded:
        raise HTTPException(429, "budget_exceeded") from None
    claims = {DocumentKind.RESUME.value: body.resume_document_id}
    if body.linkedin_document_id:
        claims[DocumentKind.LINKEDIN.value] = body.linkedin_document_id
    session_id = new_id()
    try:
        texts = await svc.db.create_session(session_id, body.target.model_dump(), claims)
    except DocumentUnavailable as error:
        code = str(error)
        raise HTTPException(404 if code == "document_not_found" else 409, code) from None
    payload = {
        "documents": {"resume": texts["resume"], "linkedin": texts.get("linkedin", "")},
        "target": body.target,
        "messages": [HumanMessage(intro(body))],
    }
    return await start(svc, session_id, "start", payload)


def chat_messages(values: dict) -> list[ChatMessage]:
    shown = []
    for message in values.get("messages") or []:
        if isinstance(message, HumanMessage | AIMessage) and message.text.strip():
            role = "user" if isinstance(message, HumanMessage) else "assistant"
            shown.append(ChatMessage(id=message.id or "", role=role, content=message.text))
    return shown


@router.get("/{session_id}", operation_id="get_session")
async def get_session(svc: Svc, session_id: str) -> SessionSnapshot:
    """Everything needed to draw the session."""
    row = await session_row(svc, session_id)
    cursor = await svc.db.last_event_id(session_id)  # first: later events are streamed
    values = await graph_values(svc, session_id)
    proposals = [p for p in (values.get("proposals") or {}).values() if p]
    return SessionSnapshot(
        session_id=session_id,
        status=row["status"],
        created_at=row["created_at"],
        target=values.get("target") or row["target"],
        has_linkedin=row["has_linkedin"],
        messages=merge_advisory(chat_messages(values), await svc.db.advisory_history(session_id)),
        profile=values.get("profile"),
        revision=review_revision(values),
        linkedin_guidance={
            p.target: guidance_for(p.target, values["profile"], values.get("linkedin"))
            for p in proposals
            if p.document.value == "linkedin"
        },
        reports={kind: report for kind, report in (values.get("reports") or {}).items()},
        gap=values.get("gap"),
        proposals=sorted(proposals, key=lambda p: p.id),
        decisions=values.get("decisions") or {},
        reviewed=bool(values.get("analyzed")),
        cost_usd=round(await svc.db.session_cost(session_id), 4),
        last_event_id=cursor,
    )


def merge_advisory(messages: list[ChatMessage], history: list[dict]) -> list[ChatMessage]:
    """Place saved advisory turns after their original conversation anchor."""
    advisory_ids = {m["id"] for m in history}
    messages = [m for m in messages if m.id not in advisory_ids]
    grouped: dict[str, list[ChatMessage]] = {}
    for item in history:
        grouped.setdefault(item["anchor_id"], []).append(
            ChatMessage(
                id=item["id"],
                role=item["role"],
                content=item["content"],
            )
        )
    result = []
    for message in messages:
        result.append(message)
        result.extend(grouped.pop(message.id, []))
    for remaining in grouped.values():
        result.extend(remaining)
    return result


@router.post("/{session_id}/ask", dependencies=[Passcode], operation_id="ask_about_session")
async def ask_about_session(svc: Svc, session_id: str, body: AskRequest) -> AskResponse:
    """Discuss saved results or draft one change without resuming a pending review."""
    row = await session_row(svc, session_id)
    async with session_claim(svc, session_id):
        if row["status"] not in {SessionStatus.REVIEW, SessionStatus.IDLE}:
            raise HTTPException(409, "session_not_ready")
        try:
            await svc.budget.check()
            return await answer_question(svc, session_id, body, await graph_values(svc, session_id))
        except BudgetExceeded:
            raise HTTPException(429, "budget_exceeded") from None
        except HTTPException:
            raise
        except Exception as error:  # noqa: BLE001  never expose document text in model errors
            raise HTTPException(502, error_code(error)) from None


def added_proposals(body: ReviewSubmit, values: dict) -> dict:
    """Rebuild explicitly submitted additions from real source targets and stable code ids."""
    additions = {}
    existing = values.get("proposals") or {}
    for item in body.additions:
        candidates = to_proposals(
            item.document,
            [
                Draft(
                    target=item.target,
                    proposed=item.proposed,
                    rationale="Explicitly reviewed draft.",
                    evidence_refs=item.evidence_refs,
                )
            ],
            values,
        )
        for pid, proposal in candidates.items():
            if pid in existing or pid in additions:
                raise HTTPException(409, "proposal_already_exists")
            issues = deterministic_issues(proposal, values)
            additions[pid] = proposal.model_copy(
                update={
                    "issues": issues,
                    "status": ProposalStatus.FLAGGED if issues else ProposalStatus.OK,
                }
            )
        if not candidates:
            raise HTTPException(422, "invalid_addition")
    return additions


def validated_decisions(body: ReviewSubmit, values: dict, additions: dict | None = None) -> dict:
    """Validate explicit user edits; generated suggestions are checked before being offered."""
    if body.expected_revision and body.expected_revision != review_revision(values):
        raise HTTPException(409, "stale_review")
    proposals = {**(values.get("proposals") or {}), **(additions or {})}
    for pid, decision in body.decisions.items():
        if pid not in proposals:
            raise HTTPException(422, "unknown_proposal")
        if decision.action.value == "edit" and not decision.text.strip():
            raise HTTPException(422, "empty_edit")
    return {pid: decision.model_dump(mode="json") for pid, decision in body.decisions.items()}


@router.post("/{session_id}/amend", dependencies=[Passcode], operation_id="amend_reviewed_session")
async def amend_reviewed_session(svc: Svc, session_id: str, body: ReviewSubmit) -> SessionSnapshot:
    """Apply explicitly reviewed edits to a completed session, without another analysis."""
    row = await session_row(svc, session_id)
    async with session_claim(svc, session_id):
        values = await graph_values(svc, session_id)
        if row["status"] != SessionStatus.IDLE or not values.get("analyzed"):
            raise HTTPException(409, "not_reviewed")
        if not body.expected_revision:
            raise HTTPException(422, "expected_revision_required")
        if body.expected_revision != review_revision(values):
            raise HTTPException(409, "stale_review")
        additions = added_proposals(body, values)
        decisions = validated_decisions(body, values, additions)
        await svc.runner.graph.aupdate_state(
            config(session_id),
            {
                "proposals": additions,
                "decisions": {pid: Decision.model_validate(d) for pid, d in decisions.items()},
            },
        )
        return await get_session(svc, session_id)


@router.post(
    "/{session_id}/reanalyze",
    status_code=202,
    dependencies=[Passcode],
    operation_id="reanalyze_session",
)
async def reanalyze_session(svc: Svc, session_id: str, body: ReanalyzeRequest) -> RunAccepted:
    """Replace saved results only after the user explicitly confirms a fresh analysis."""
    row = await session_row(svc, session_id)
    if row["status"] == SessionStatus.REVIEW:
        raise HTTPException(409, "review_pending")
    return await start(
        svc,
        session_id,
        "reanalyze",
        {
            "target": body.target,
            "route": "analyze_confirmed",
            "analyzed": False,
            "reports": Overwrite({}),
            "proposals": Overwrite({}),
            "decisions": Overwrite({}),
            "gap": None,
            "critique": {},
            "critique_rounds": 0,
            "keyword_evidence": {},
            "messages": [HumanMessage(f"Confirmed a fresh analysis for {body.target.title}.")],
        },
    )


@router.post(
    "/{session_id}/messages", status_code=202, dependencies=[Passcode], operation_id="send_message"
)
async def send_message(svc: Svc, session_id: str, body: MessageCreate) -> RunAccepted:
    """Send the assistant a message."""
    row = await session_row(svc, session_id)
    if row["status"] == SessionStatus.REVIEW:
        raise HTTPException(409, "review_pending")
    values = await graph_values(svc, session_id)
    history = current_history(values, await svc.db.advisory_history(session_id))
    replay = [
        (HumanMessage if m["role"] == "user" else AIMessage)(content=m["content"], id=m["id"])
        for m in history
    ]
    return await start(
        svc, session_id, "message", {"messages": [*replay, HumanMessage(body.content)]}
    )


@router.post(
    "/{session_id}/review", status_code=202, dependencies=[Passcode], operation_id="submit_review"
)
async def submit_review(svc: Svc, session_id: str, body: ReviewSubmit) -> RunAccepted:
    """Decide on the proposals; the analysis then finishes."""
    row = await session_row(svc, session_id)
    if row["status"] != SessionStatus.REVIEW:
        raise HTTPException(409, "no_review_pending")
    values = await graph_values(svc, session_id)
    additions = added_proposals(body, values)
    decisions = validated_decisions(body, values, additions)
    payload = resume_with(decisions)
    payload["additional_proposals"] = {
        pid: p.model_dump(mode="json") for pid, p in additions.items()
    }
    return await start(svc, session_id, "review", Command(resume=payload))


@router.post(
    "/{session_id}/resume", status_code=202, dependencies=[Passcode], operation_id="resume_session"
)
async def resume_session(svc: Svc, session_id: str) -> RunAccepted:
    """Continue a run that was cut off, from its last checkpoint."""
    row = await session_row(svc, session_id)
    if row["status"] != SessionStatus.INTERRUPTED:
        raise HTTPException(409, "not_interrupted")
    return await start(svc, session_id, "resume", None)


EXPORT_TYPES = {
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "md": "text/markdown; charset=utf-8",
    "html": "text/html; charset=utf-8",
}
# The print view is our own escaped HTML; it may not run or load anything.
PRINT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:"


@router.get(
    "/{session_id}/export",
    operation_id="export_session",
    responses={200: {"content": {media: {} for media in EXPORT_TYPES.values()}}},
)
async def export_session(
    svc: Svc,
    session_id: str,
    format: Annotated[Literal["docx", "md", "html", "json"], Query()] = "docx",
) -> Response:
    """The reviewed documents: DOCX resume, Markdown (resume + LinkedIn), a print-ready HTML
    page (for Save as PDF), or JSON (resume + LinkedIn copy) for the app to show."""
    await session_row(svc, session_id)
    values = await graph_values(svc, session_id)
    if not values.get("analyzed"):
        raise HTTPException(409, "not_reviewed")
    final = apply_decisions(
        values["profile"],
        values.get("linkedin"),
        {pid: p for pid, p in values["proposals"].items() if p},
        values.get("decisions") or {},
    )
    if format == "json":
        return JSONResponse(final.model_dump(mode="json"))
    if format == "html":
        return Response(
            export.html_page(final),
            media_type=EXPORT_TYPES["html"],
            headers={"Content-Security-Policy": PRINT_CSP},
        )
    name = export.filename(final.resume, values["target"].title, format)
    headers = {"Content-Disposition": f'attachment; filename="{name}"'}
    body = export.markdown(final) if format == "md" else export.docx_bytes(final.resume)
    return Response(body, media_type=EXPORT_TYPES[format], headers=headers)


@router.get(
    "/{session_id}/events",
    operation_id="stream_events",
    responses={200: {"content": {"text/event-stream": {}}}},
)
async def stream_events(
    svc: Svc,
    session_id: str,
    request: Request,
    after: Annotated[int, Query(ge=0)] = 0,
    last_event_id: Annotated[str, Header()] = "",
) -> StreamingResponse:
    """The session's live events (Server-Sent Events), from just after a cursor."""
    await session_row(svc, session_id)
    cursor = int(last_event_id) if last_event_id.isdigit() else after
    return StreamingResponse(
        event_stream(svc.bus, session_id, cursor, request.is_disconnected),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
