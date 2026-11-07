"""The app on stub models, memory checkpoints and a fresh SQLite file per test."""

from dataclasses import replace

import httpx
import pytest

from agent.checkpoints import memory_saver
from agent.tests import stubs
from backend.database import Database, engine_for
from backend.main import create_app
from backend.services import build_services
from backend.settings import Settings

PASSCODE = "open-sesame"


@pytest.fixture
def settings(tmp_path) -> Settings:
    return Settings(
        sqlite_path=tmp_path / "test.db",
        demo_passcode=PASSCODE,
        max_daily_cost_usd=5.0,
        web_dist=tmp_path / "no-web",
    )


@pytest.fixture
def script() -> stubs.Script:
    return stubs.Script()


@pytest.fixture
async def services(settings, script):
    db = Database(engine_for(settings))
    await db.create()
    svc = build_services(settings, db, memory_saver(), stubs.models(script), stubs.toolbox())
    yield svc
    await svc.runner.shutdown()
    await db.engine.dispose()


@pytest.fixture
async def client(services):
    app = create_app(services)
    app.state.services = services  # the test transport doesn't run the lifespan
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://test", headers={"X-Demo-Passcode": PASSCODE}
    ) as http:
        yield http


def with_settings(services, **changes):
    services.settings = replace(services.settings, **changes)
    return services
