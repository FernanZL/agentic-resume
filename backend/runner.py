"""Runs of a session's graph, in the background of the one API process: one at a time
per session, each streamed into run_events as it goes, ending in the session's next
status (idle, or paused for review)."""

import asyncio
import logging
import time
from collections.abc import Callable
from typing import Any

import httpx
import openai
from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.exceptions import OutputParserException
from langchain_core.messages import AIMessageChunk
from langgraph.graph.state import CompiledStateGraph
from pydantic import ValidationError

from agent.graph import run_config
from agent.llm import NoStructuredAnswer
from agent.state import RunContext
from backend.budget import Budget, BudgetExceeded, CostRecorder
from backend.database import Database, new_id
from backend.events import EventBus
from backend.schemas import EventType, SessionStatus

log = logging.getLogger(__name__)
TOKEN_FLUSH = 0.15  # seconds of reply text gathered into one token event
STREAM_NODE = "concierge"  # whose reply is streamed token by token


class RunActive(RuntimeError):
    """The session already has a run working."""


class Runner:
    def __init__(
        self,
        db: Database,
        bus: EventBus,
        graph: CompiledStateGraph,
        budget: Budget,
        extra_callbacks: Callable[[str], list[BaseCallbackHandler]] = lambda _: [],
        error_details: bool = False,
    ):
        self.db = db
        self.bus = bus
        self.graph = graph
        self.budget = budget
        self.extra_callbacks = extra_callbacks
        self.error_details = error_details  # log exception messages (may echo document text)
        self.tasks: dict[str, asyncio.Task] = {}
        self.claimed: set[str] = set()  # sessions with a run starting or working

    def active(self, session_id: str) -> bool:
        return session_id in self.claimed

    async def start(self, session_id: str, kind: str, payload: Any) -> str:
        """Start a run in the background and return its id. Raises RunActive or
        BudgetExceeded before anything starts."""
        if session_id in self.claimed:
            raise RunActive(session_id)
        self.claimed.add(session_id)  # before any await: two requests can't both pass
        try:
            await self.budget.check()
            run_id = new_id()
            await self.db.add_run(run_id, session_id, kind)
            await self.db.set_status(session_id, SessionStatus.RUNNING)
            await self.bus.record(session_id, run_id, EventType.RUN_STARTED, data={"kind": kind})
        except BaseException:
            self.claimed.discard(session_id)
            raise
        task = asyncio.create_task(self._execute(session_id, run_id, payload), name=f"run-{run_id}")
        self.tasks[session_id] = task
        task.add_done_callback(lambda _: self._release(session_id))
        return run_id

    def _release(self, session_id: str) -> None:
        self.tasks.pop(session_id, None)
        self.claimed.discard(session_id)

    async def wait(self, session_id: str) -> None:
        """Wait for the session's run to end (tests and shutdown)."""
        if task := self.tasks.get(session_id):
            await asyncio.gather(task, return_exceptions=True)

    async def shutdown(self) -> None:
        for task in list(self.tasks.values()):
            task.cancel()
        await asyncio.gather(*self.tasks.values(), return_exceptions=True)

    async def _execute(self, session_id: str, run_id: str, payload: Any) -> None:
        callbacks = [
            CostRecorder(self.budget, session_id, run_id),
            *self.extra_callbacks(session_id),
        ]
        config = run_config(session_id, run_id, callbacks)
        try:
            await self._stream(session_id, run_id, payload, config)
            status = await self.status_after_run(session_id)
            await self._finish(session_id, run_id, status, "completed")
        except asyncio.CancelledError:
            await self._finish(session_id, run_id, SessionStatus.INTERRUPTED, "interrupted")
            raise
        except Exception as error:  # noqa: BLE001  any failure ends the run, recorded
            code = error_code(error)
            if self.error_details:
                log.exception("Run %s failed (%s)", run_id, code)
            else:  # the message itself may quote the user's documents
                log.error("Run %s failed (%s): %s", run_id, code, describe(error))
            await self._fail(session_id, run_id, code)

    async def _stream(self, session_id: str, run_id: str, payload: Any, config: dict) -> None:
        tokens = TokenBuffer()
        context = RunContext(session_id=session_id, run_id=run_id)
        async for _, mode, chunk in self.graph.astream(
            payload, config, context=context, stream_mode=["custom", "messages"], subgraphs=True
        ):
            if mode == "custom":
                await self._flush(session_id, run_id, tokens)
                await self.bus.record(
                    session_id,
                    run_id,
                    chunk["type"],
                    chunk.get("node", ""),
                    chunk.get("data") or {},
                )
            elif tokens.add(*chunk) and tokens.due():
                await self._flush(session_id, run_id, tokens)
        await self._flush(session_id, run_id, tokens)

    async def _flush(self, session_id: str, run_id: str, tokens: "TokenBuffer") -> None:
        if text := tokens.take():
            await self.bus.record(session_id, run_id, EventType.TOKEN, STREAM_NODE, {"text": text})

    async def status_after_run(self, session_id: str) -> SessionStatus:
        """Paused for review if the graph waits on the review's interrupt, else idle."""
        state = await self.graph.aget_state({"configurable": {"thread_id": session_id}})
        if state.interrupts:
            ids = state.interrupts[0].value.get("proposal_ids", [])
            await self.bus.record(
                session_id, "", EventType.REVIEW_REQUIRED, "review", {"proposal_ids": ids}
            )
            return SessionStatus.REVIEW
        return SessionStatus.IDLE

    async def _finish(
        self, session_id: str, run_id: str, status: SessionStatus, run_status: str
    ) -> None:
        await self.db.finish_run(run_id, run_status)
        await self.db.set_status(session_id, status)
        await self.bus.record(
            session_id, run_id, EventType.RUN_COMPLETED, data={"status": status.value}
        )

    async def _fail(self, session_id: str, run_id: str, error: str) -> None:
        await self.db.finish_run(run_id, "failed", error)
        await self.db.set_status(session_id, SessionStatus.FAILED)
        await self.bus.record(session_id, run_id, EventType.RUN_FAILED, data={"error": error})


def error_code(error: BaseException) -> str:
    """What the user is told a run failed of: a code, never the exception's text."""
    if isinstance(error, BudgetExceeded):
        return "budget_exceeded"
    if isinstance(error, NoStructuredAnswer | ValidationError | OutputParserException):
        return "invalid_model_output"
    if isinstance(error, openai.APIError | httpx.HTTPError):
        return "model_error"
    return "internal_error"


def describe(error: BaseException) -> str:
    """An exception for the logs without its message: its type, and an API's status."""
    status = getattr(error, "status_code", None)
    return f"{type(error).__name__}" + (f" (HTTP {status})" if status else "")


class TokenBuffer:
    """The concierge's reply text, gathered into chunks worth an event."""

    def __init__(self):
        self.parts: list[str] = []
        self.since = time.monotonic()

    def add(self, message: Any, metadata: dict) -> bool:
        if metadata.get("langgraph_node") != STREAM_NODE or not isinstance(message, AIMessageChunk):
            return False
        text = message.text
        if text:
            self.parts.append(text)
        return bool(text)

    def due(self) -> bool:
        return time.monotonic() - self.since >= TOKEN_FLUSH

    def take(self) -> str:
        text, self.parts, self.since = "".join(self.parts), [], time.monotonic()
        return text
