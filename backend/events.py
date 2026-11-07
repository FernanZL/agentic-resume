"""Live events: every event is written to run_events first, then listeners are woken.
The SSE stream only ever reads the table after its cursor, so a reconnect with
Last-Event-ID replays exactly what was missed: no event lost, none twice."""

import asyncio
import json
from collections import defaultdict
from collections.abc import AsyncIterator, Awaitable, Callable

from backend.database import Database
from backend.schemas import Event

KEEP_ALIVE = 15.0  # seconds between pings on a quiet stream
BATCH = 200


class EventBus:
    """Records events and wakes the streams of their session."""

    def __init__(self, db: Database):
        self.db = db
        self.versions: dict[str, int] = defaultdict(int)
        self.conditions: dict[str, asyncio.Condition] = defaultdict(asyncio.Condition)

    async def record(
        self, session_id: str, run_id: str, type_: str, node: str = "", data: dict | None = None
    ) -> int:
        event_id = await self.db.add_event(session_id, run_id, type_, node, data or {})
        condition = self.conditions[session_id]
        async with condition:
            self.versions[session_id] += 1
            condition.notify_all()
        return event_id

    def version(self, session_id: str) -> int:
        return self.versions[session_id]

    async def wait(self, session_id: str, seen: int, within: float) -> bool:
        """Wait until there is something newer than version seen; False on timeout."""
        condition = self.conditions[session_id]
        try:
            async with condition:
                await asyncio.wait_for(
                    condition.wait_for(lambda: self.versions[session_id] != seen), within
                )
            return True
        except TimeoutError:
            return False


def to_sse(row: dict) -> str:
    event = Event.model_validate({**row, "at": row["created_at"]})
    return f"id: {event.id}\nevent: {event.type.value}\ndata: {event.model_dump_json()}\n\n"


async def event_stream(
    bus: EventBus,
    session_id: str,
    cursor: int,
    disconnected: Callable[[], Awaitable[bool]],
    keep_alive: float = KEEP_ALIVE,
) -> AsyncIterator[str]:
    """The text/event-stream of a session from just after cursor, until the client goes."""
    yield "retry: 3000\n\n"
    while not await disconnected():
        seen = bus.version(session_id)  # before the read, so no wake-up is missed
        rows = await bus.db.events_after(session_id, cursor, BATCH)
        for row in rows:
            cursor = row["id"]
            yield to_sse(row)
        if len(rows) == BATCH:
            continue
        if not await bus.wait(session_id, seen, keep_alive):
            yield ": ping\n\n"


def short_json(value: object, limit: int = 2000) -> str:
    text = json.dumps(value, ensure_ascii=False, default=str)
    return text if len(text) <= limit else text[:limit] + "…"
