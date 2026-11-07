"""The checkpoints, where the session graph saves its progress: Postgres in production
(its own schema, pooler-safe), memory in tests. Only our own schema classes may be
deserialized from a checkpoint."""

import enum
import inspect
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer
from pydantic import BaseModel

from agent import schemas

SCHEMA = "agentic_resume"
CONNECTIONS = 4


def allowed_classes() -> list[tuple[str, str]]:
    """Every model and enum in agent.schemas: what a checkpoint may contain besides
    LangGraph's and LangChain's own safe types."""
    return [
        (schemas.__name__, name)
        for name, value in vars(schemas).items()
        if inspect.isclass(value)
        and value.__module__ == schemas.__name__
        and issubclass(value, BaseModel | enum.Enum)
    ]


def serializer() -> JsonPlusSerializer:
    return JsonPlusSerializer(allowed_msgpack_modules=allowed_classes())


def memory_saver() -> InMemorySaver:
    return InMemorySaver(serde=serializer())


@asynccontextmanager
async def postgres_saver(database_url: str) -> AsyncIterator[BaseCheckpointSaver]:
    """An AsyncPostgresSaver on a pool of CONNECTIONS connections, in our own schema, set
    up once. Prepared statements are off, so it works through Supabase's poolers."""
    from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
    from psycopg import AsyncConnection, sql
    from psycopg.rows import dict_row
    from psycopg_pool import AsyncConnectionPool

    async with await AsyncConnection.connect(database_url, autocommit=True) as connection:
        await connection.execute(
            sql.SQL("CREATE SCHEMA IF NOT EXISTS {}").format(sql.Identifier(SCHEMA))
        )
    settings = {
        "autocommit": True,
        "prepare_threshold": None,
        "row_factory": dict_row,
        "options": f"-c search_path={SCHEMA}",
    }
    async with AsyncConnectionPool(
        database_url, min_size=1, max_size=CONNECTIONS, kwargs=settings, open=False
    ) as pool:
        saver = AsyncPostgresSaver(pool, serde=serializer())
        await saver.setup()
        yield saver
