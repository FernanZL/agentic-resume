"""On a real Postgres (TEST_DATABASE_URL, e.g. `docker compose up db`): a session paused for
review survives a restart of the process (new pools, new graph) and finishes from its
checkpoint; events keep their order."""

import os
import uuid
from contextlib import asynccontextmanager

import pytest
from langchain_core.messages import HumanMessage
from langgraph.types import Command

from agent.checkpoints import postgres_saver
from agent.nodes.review import resume_with
from agent.tests import stubs
from backend.database import Database, engine_for
from backend.services import build_services
from backend.settings import Settings

URL = os.environ.get("TEST_DATABASE_URL", "")
pytestmark = [
    pytest.mark.postgres,
    pytest.mark.skipif(not URL, reason="TEST_DATABASE_URL is not set"),
]


@asynccontextmanager
async def process():
    """One 'process': its own engine, checkpoint pool and graph on the shared database."""
    settings = Settings(database_url=URL, max_daily_cost_usd=0)
    db = Database(engine_for(settings))
    await db.create()
    async with postgres_saver(URL) as saver:
        svc = build_services(settings, db, saver, stubs.models(), stubs.toolbox())
        try:
            yield svc
        finally:
            await svc.runner.shutdown()
            await db.engine.dispose()


async def test_a_paused_session_survives_a_restart():
    session_id = str(uuid.uuid4())
    async with process() as first:
        await first.db.add_session(session_id, stubs.TARGET.model_dump(), True)
        await first.runner.start(session_id, "start", stubs.first_input())
        await first.runner.wait(session_id)
        assert (await first.db.get_session(session_id))["status"] == "review"
        state = await first.runner.graph.aget_state({"configurable": {"thread_id": session_id}})
        anchor = state.values["messages"][0].id
        await first.db.add_advisory_turn(
            session_id, anchor, "Why this proposal?", "It preserves the source facts."
        )

    async with process() as second:
        config = {"configurable": {"thread_id": session_id}}
        state = await second.runner.graph.aget_state(config, subgraphs=True)
        assert state.next == ("analysis",)
        assert state.interrupts[0].value["proposal_ids"]
        history = await second.db.advisory_history(session_id)
        assert [m["role"] for m in history] == ["user", "assistant"]
        assert history[0]["content"] == "Why this proposal?"
        await second.runner.start(session_id, "review", Command(resume=resume_with({})))
        await second.runner.wait(session_id)
        values = (await second.runner.graph.aget_state(config)).values
        assert values["analyzed"] is True
        assert (await second.db.get_session(session_id))["status"] == "idle"

        await second.runner.start(session_id, "message", {"messages": [HumanMessage("thanks")]})
        await second.runner.wait(session_id)
        events = await second.db.events_after(session_id, 0, 1000)
        ids = [event["id"] for event in events]
        assert ids == sorted(ids)
        assert len(set(ids)) == len(ids)
        assert [e["type"] for e in events].count("run_started") == 3
