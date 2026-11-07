"""The FastAPI app: the API under /api and, in production, the built web app at /."""

import logging
from collections.abc import AsyncIterator
from contextlib import AsyncExitStack, asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from agent.checkpoints import memory_saver, postgres_saver
from backend.database import Database, engine_for
from backend.routers import documents, sessions
from backend.schemas import Health
from backend.services import (
    Services,
    Svc,
    build_services,
    real_models,
    real_toolbox,
    real_tracer,
)
from backend.settings import Settings, load

log = logging.getLogger(__name__)


@asynccontextmanager
async def real_services(settings: Settings) -> AsyncIterator[Services]:
    """The services on the real database, checkpoints, models and tools."""
    async with AsyncExitStack() as stack:
        engine = engine_for(settings)
        stack.push_async_callback(engine.dispose)
        db = Database(engine)
        await db.create()
        if stale := await db.interrupt_stale_runs():
            log.warning("%d runs were cut off by a restart; they can be resumed", stale)
        client = await stack.enter_async_context(
            httpx.AsyncClient(timeout=15, follow_redirects=True)
        )
        if settings.database_url:
            saver = await stack.enter_async_context(postgres_saver(settings.database_url))
        else:
            log.warning("No DATABASE_URL: SQLite and in-memory checkpoints (local use only)")
            saver = memory_saver()
        tracer = real_tracer(settings)
        stack.callback(tracer.shutdown)  # last out: flushes the traces of runs cut off below
        svc = build_services(
            settings, db, saver, real_models(settings), real_toolbox(settings, client), tracer
        )
        stack.push_async_callback(svc.runner.shutdown)
        yield svc


def create_app(services: Services | None = None, settings: Settings | None = None) -> FastAPI:
    """The app; tests pass their own services."""
    settings = settings or (services.settings if services else load())

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        if services:
            app.state.services = services
            yield
            return
        async with real_services(settings) as svc:
            app.state.services = svc
            yield

    app = FastAPI(title="Agentic Resume", version="0.1.0", lifespan=lifespan)
    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(settings.cors_origins),
            allow_methods=["*"],
            allow_headers=["*"],
        )
    app.include_router(documents.router)
    app.include_router(sessions.router)

    @app.get("/api/health", tags=["health"], operation_id="health")
    async def health(svc: Svc) -> Health:
        """Whether the app and its database are up."""
        return Health(status="ok", database=await svc.db.ping())

    serve_web(app, settings.web_dist)
    return app


def serve_web(app: FastAPI, dist: Path) -> None:
    """Serve the built web app, with index.html for its client-side routes."""
    index = dist / "index.html"
    root = dist.resolve()

    @app.get("/{path:path}", include_in_schema=False)
    async def web(path: str) -> FileResponse:
        if path.startswith("api/") or not index.exists():
            raise HTTPException(404, "not_found")
        file = (dist / path).resolve()
        if path and file.is_file() and file.is_relative_to(root):
            return FileResponse(file)
        return FileResponse(index)


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
# Run with: uvicorn --factory backend.main:create_app
