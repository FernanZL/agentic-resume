"""The app's tables (SQLAlchemy Core, async) and the queries on them. Agent output
(reports, proposals, decisions) is not here: it lives in the graph's checkpoints."""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    Column,
    DateTime,
    Float,
    Index,
    Integer,
    MetaData,
    String,
    Table,
    Text,
    event,
    func,
    insert,
    select,
    text,
    update,
)
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from agent.checkpoints import SCHEMA
from backend.settings import Settings

metadata = MetaData()
BigId = BigInteger().with_variant(Integer, "sqlite")  # SQLite only autoincrements INTEGER

sessions = Table(
    "sessions",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("target", JSON, nullable=False),
    Column("has_linkedin", Boolean, nullable=False),
    Column("status", String(16), nullable=False),
)
documents = Table(
    "documents",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("session_id", String(36), index=True),  # null until a session claims it
    Column("kind", String(16), nullable=False),
    Column("filename", String(255), nullable=False),
    Column("text", Text, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
)
runs = Table(
    "runs",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("session_id", String(36), nullable=False, index=True),
    Column("kind", String(16), nullable=False),
    Column("status", String(16), nullable=False),
    Column("error", Text, nullable=False, default=""),
    Column("started_at", DateTime(timezone=True), nullable=False),
    Column("finished_at", DateTime(timezone=True)),
)
run_events = Table(
    "run_events",
    metadata,
    Column("id", BigId, primary_key=True, autoincrement=True),
    Column("session_id", String(36), nullable=False),
    Column("run_id", String(36), nullable=False),
    Column("type", String(32), nullable=False),
    Column("node", String(48), nullable=False, default=""),
    Column("data", JSON, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Index("ix_run_events_session_id_id", "session_id", "id"),
)
model_calls = Table(
    "model_calls",
    metadata,
    Column("id", BigId, primary_key=True, autoincrement=True),
    Column("session_id", String(36), nullable=False, index=True),
    Column("run_id", String(36), nullable=False),
    Column("node", String(48), nullable=False),
    Column("model", String(128), nullable=False),
    Column("input_tokens", Integer, nullable=False),
    Column("output_tokens", Integer, nullable=False),
    Column("cost", Float, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False, index=True),
)


def now() -> datetime:
    return datetime.now(UTC)


def new_id() -> str:
    return str(uuid.uuid4())


def engine_for(settings: Settings) -> AsyncEngine:
    """Postgres (our own schema, pooler-safe) when DATABASE_URL is set, else SQLite."""
    if not settings.database_url:
        engine = create_async_engine(
            f"sqlite+aiosqlite:///{settings.sqlite_path}", connect_args={"timeout": 30}
        )

        @event.listens_for(engine.sync_engine, "connect")
        def wal(connection, _record):  # parallel writers wait instead of failing
            connection.execute("PRAGMA journal_mode=WAL")

        return engine
    url = settings.database_url.replace("postgres://", "postgresql://", 1)
    url = url.replace("postgresql://", "postgresql+psycopg://", 1)
    return create_async_engine(
        url,
        pool_size=3,
        max_overflow=2,
        pool_pre_ping=True,
        connect_args={"prepare_threshold": None, "options": f"-c search_path={SCHEMA}"},
    )


class DocumentUnavailable(LookupError):
    """A document can't be used: it doesn't exist (or is another kind) or is taken."""


class Database:
    """The app's queries, one method per question asked."""

    def __init__(self, engine: AsyncEngine):
        self.engine = engine

    async def create(self) -> None:
        async with self.engine.begin() as connection:
            if connection.dialect.name == "postgresql":
                await connection.execute(text(f'CREATE SCHEMA IF NOT EXISTS "{SCHEMA}"'))
            await connection.run_sync(metadata.create_all)

    async def ping(self) -> bool:
        try:
            async with self.engine.connect() as connection:
                await connection.execute(select(1))
            return True
        except Exception:  # noqa: BLE001  health reports it, it doesn't raise
            return False

    # documents
    async def add_document(self, kind: str, filename: str, body: str) -> str:
        document_id = new_id()
        async with self.engine.begin() as connection:
            await connection.execute(
                insert(documents).values(
                    id=document_id, kind=kind, filename=filename, text=body, created_at=now()
                )
            )
        return document_id

    async def create_session(
        self, session_id: str, target: dict, claims: dict[str, str]
    ) -> dict[str, str]:
        """In one transaction: give each unclaimed document (kind -> id) to a new session,
        and create it. Returns each document's text by kind; raises DocumentUnavailable
        and changes nothing when a document is missing, of the wrong kind, or taken."""
        texts: dict[str, str] = {}
        async with self.engine.begin() as connection:
            for kind, document_id in claims.items():
                claimed = await connection.execute(
                    update(documents)
                    .where(
                        documents.c.id == document_id,
                        documents.c.kind == kind,
                        documents.c.session_id.is_(None),
                    )
                    .values(session_id=session_id)
                    .returning(documents.c.text)
                )
                text = claimed.scalar_one_or_none()
                if text is None:
                    exists = await connection.execute(
                        select(documents.c.id).where(documents.c.id == document_id)
                    )
                    raise DocumentUnavailable(
                        "document_already_used" if exists.first() else "document_not_found"
                    )
                texts[kind] = text
            await connection.execute(
                insert(sessions).values(
                    id=session_id,
                    created_at=now(),
                    target=target,
                    has_linkedin="linkedin" in claims,
                    status="idle",
                )
            )
        return texts

    async def document_exists(self, document_id: str) -> bool:
        async with self.engine.connect() as connection:
            row = await connection.execute(
                select(documents.c.id).where(documents.c.id == document_id)
            )
            return row.first() is not None

    # sessions
    async def add_session(self, session_id: str, target: dict, has_linkedin: bool) -> None:
        async with self.engine.begin() as connection:
            await connection.execute(
                insert(sessions).values(
                    id=session_id,
                    created_at=now(),
                    target=target,
                    has_linkedin=has_linkedin,
                    status="idle",
                )
            )

    async def get_session(self, session_id: str) -> dict[str, Any] | None:
        async with self.engine.connect() as connection:
            row = await connection.execute(select(sessions).where(sessions.c.id == session_id))
            found = row.mappings().first()
            return dict(found) if found else None

    async def set_status(self, session_id: str, status: str) -> None:
        async with self.engine.begin() as connection:
            await connection.execute(
                update(sessions).where(sessions.c.id == session_id).values(status=status)
            )

    # runs
    async def add_run(self, run_id: str, session_id: str, kind: str) -> None:
        async with self.engine.begin() as connection:
            await connection.execute(
                insert(runs).values(
                    id=run_id,
                    session_id=session_id,
                    kind=kind,
                    status="running",
                    error="",
                    started_at=now(),
                )
            )

    async def finish_run(self, run_id: str, status: str, error: str = "") -> None:
        async with self.engine.begin() as connection:
            await connection.execute(
                update(runs)
                .where(runs.c.id == run_id)
                .values(status=status, error=error[:2000], finished_at=now())
            )

    async def interrupt_stale_runs(self) -> int:
        """Runs left 'running' by a process that stopped become 'interrupted', and so do
        their sessions; returns how many."""
        async with self.engine.begin() as connection:
            stale = await connection.execute(
                update(runs)
                .where(runs.c.status == "running")
                .values(status="interrupted", finished_at=now())
            )
            await connection.execute(
                update(sessions).where(sessions.c.status == "running").values(status="interrupted")
            )
            return stale.rowcount

    # events
    async def add_event(
        self, session_id: str, run_id: str, type_: str, node: str, data: dict
    ) -> int:
        async with self.engine.begin() as connection:
            result = await connection.execute(
                insert(run_events)
                .values(
                    session_id=session_id,
                    run_id=run_id,
                    type=type_,
                    node=node,
                    data=data,
                    created_at=now(),
                )
                .returning(run_events.c.id)
            )
            return result.scalar_one()

    async def events_after(self, session_id: str, after: int, limit: int = 200) -> list[dict]:
        async with self.engine.connect() as connection:
            rows = await connection.execute(
                select(run_events)
                .where(run_events.c.session_id == session_id, run_events.c.id > after)
                .order_by(run_events.c.id)
                .limit(limit)
            )
            return [dict(row) for row in rows.mappings()]

    async def last_event_id(self, session_id: str) -> int:
        async with self.engine.connect() as connection:
            row = await connection.execute(
                select(func.max(run_events.c.id)).where(run_events.c.session_id == session_id)
            )
            return row.scalar() or 0

    # costs
    async def add_model_call(
        self,
        session_id: str,
        run_id: str,
        node: str,
        model: str,
        input_tokens: int,
        output_tokens: int,
        cost: float,
    ) -> None:
        async with self.engine.begin() as connection:
            await connection.execute(
                insert(model_calls).values(
                    session_id=session_id,
                    run_id=run_id,
                    node=node,
                    model=model,
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    cost=cost,
                    created_at=now(),
                )
            )

    async def spent_since(self, hours: int = 24) -> float:
        async with self.engine.connect() as connection:
            row = await connection.execute(
                select(func.coalesce(func.sum(model_calls.c.cost), 0.0)).where(
                    model_calls.c.created_at > now() - timedelta(hours=hours)
                )
            )
            return float(row.scalar() or 0.0)

    async def session_cost(self, session_id: str) -> float:
        async with self.engine.connect() as connection:
            row = await connection.execute(
                select(func.coalesce(func.sum(model_calls.c.cost), 0.0)).where(
                    model_calls.c.session_id == session_id
                )
            )
            return float(row.scalar() or 0.0)
