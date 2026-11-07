"""Runs of a session's graph, in the background of the one API process: one at a time
per session, each streamed into run_events as it goes, ending in the session's next
status (idle, or paused for review)."""

import asyncio
import logging
import time
from typing import Any

from langchain_core.messages import AIMessage, AIMessageChunk
from langgraph.graph.state import CompiledStateGraph
from langgraph.types import StateSnapshot

from agent.graph import run_config
from agent.state import RunContext
from backend.budget import Budget, CostRecorder
from backend.database import Database, new_id
from backend.errors import describe, error_code
from backend.events import EventBus
from backend.schemas import EventType, SessionStatus
from backend.tracing import Tracer

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
        tracer: Tracer | None = None,
        error_details: bool = False,
    ):
        self.db = db
        self.bus = bus
        self.graph = graph
        self.budget = budget
        self.tracer = tracer or Tracer()
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
        task = asyncio.create_task(
            self._execute(session_id, run_id, kind, payload), name=f"run-{run_id}"
        )
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

    async def _execute(self, session_id: str, run_id: str, kind: str, payload: Any) -> None:
        # The trace only observes: the tracer never raises, and it is told the outcome
        # only once the outcome is recorded.
        with self.tracer.run(session_id, run_id, kind, payload) as trace:
            callbacks = [CostRecorder(self.budget, session_id, run_id), *trace.callbacks]
            config = run_config(session_id, run_id, callbacks)
            try:
                await self._stream(session_id, run_id, payload, config)
                state = await self.graph.aget_state({"configurable": config["configurable"]})
                status = await self.status_after_run(session_id, state)
                await self._finish(session_id, run_id, status, "completed")
            except asyncio.CancelledError:
                await self._finish(session_id, run_id, SessionStatus.INTERRUPTED, "interrupted")
                trace.fail("interrupted")
                raise
            except Exception as error:  # noqa: BLE001  any failure ends the run, recorded
                code = error_code(error)
                if self.error_details:
                    log.exception("Run %s failed (%s)", run_id, code)
                else:  # the message itself may quote the user's documents
                    log.error("Run %s failed (%s): %s", run_id, code, describe(error))
                await self._fail(session_id, run_id, code)
                trace.fail(code)
            else:
                trace.finish({"status": status.value, "reply": last_reply(state)})

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

    async def status_after_run(self, session_id: str, state: StateSnapshot) -> SessionStatus:
        """Paused for review if the graph waits on the review's interrupt, else idle."""
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


def last_reply(state: StateSnapshot) -> str | None:
    """The assistant's reply that ended the run, if it ended on one."""
    messages = state.values.get("messages") or []
    return messages[-1].text if messages and isinstance(messages[-1], AIMessage) else None


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
