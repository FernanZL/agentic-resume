"""What the API works with, built once at startup: the database, the event bus, the
graph and the runner. Tests build it with stub models and memory checkpoints."""

import secrets
from dataclasses import dataclass
from functools import partial
from typing import Annotated

import httpx
from fastapi import Depends, Header, HTTPException, Request
from langgraph.checkpoint.base import BaseCheckpointSaver

from agent.graph import build_graph
from agent.llm import Models, chat_model
from agent.toolbox import Toolbox
from agent.tools.fetch_url import fetch_text, make_fetch_tool
from agent.tools.linkedin import make_linkedin_search
from agent.tools.web_search import make_web_search
from backend.budget import Budget
from backend.database import Database
from backend.events import EventBus
from backend.runner import Runner
from backend.settings import Settings
from backend.tracing import LangfuseTracer, Tracer


@dataclass
class Services:
    settings: Settings
    db: Database
    bus: EventBus
    runner: Runner
    budget: Budget
    models: Models


# What each role's model calls are named in traces: stable, verb-first.
STEP_NAMES = {
    "concierge": "reply-to-user",
    "intake": "read-documents",
    "researcher": "research-target",
    "analyst": "analyze-fit",
    "writer": "rewrite-documents",
    "critic": "check-rewrites",
}


def real_models(settings: Settings) -> Models:
    """The models on OpenRouter, one per role as configured."""
    key = settings.openrouter_api_key or "missing-key"  # calls fail clearly without one

    def model(role: str, temperature: float = 0.2):
        return chat_model(settings.models[role], key, temperature, STEP_NAMES[role])

    return Models(
        concierge=model("concierge", 0.4),
        intake=model("intake", 0.0),
        researcher=model("researcher"),
        analyst=model("analyst"),
        writer=model("writer", 0.5),
        critic=model("critic", 0.0),
    )


def real_toolbox(settings: Settings, client: httpx.AsyncClient) -> Toolbox:
    return Toolbox(
        web_search=make_web_search(settings.tavily_api_key),
        linkedin_search=make_linkedin_search(settings.tavily_api_key),
        fetch_url=make_fetch_tool(client),
        fetch=partial(fetch_text, client=client),
    )


def real_tracer(settings: Settings) -> Tracer:
    """Langfuse tracing when its keys are set, else none."""
    if not (settings.langfuse_public_key and settings.langfuse_secret_key):
        return Tracer()
    return LangfuseTracer(
        public_key=settings.langfuse_public_key,
        secret_key=settings.langfuse_secret_key,
        base_url=settings.langfuse_base_url,
        environment=settings.langfuse_environment,
    )


def build_services(
    settings: Settings,
    db: Database,
    saver: BaseCheckpointSaver,
    models: Models,
    toolbox: Toolbox,
    tracer: Tracer | None = None,
) -> Services:
    bus = EventBus(db)
    budget = Budget(db, settings.max_daily_cost_usd, settings.call_reservation_usd)
    graph = build_graph(models, toolbox, saver)
    runner = Runner(db, bus, graph, budget, tracer, settings.log_error_details)
    return Services(settings=settings, db=db, bus=bus, runner=runner, budget=budget, models=models)


def services(request: Request) -> Services:
    return request.app.state.services


Svc = Annotated[Services, Depends(services)]


def require_passcode(svc: Svc, x_demo_passcode: Annotated[str, Header()] = "") -> None:
    """Every POST needs the demo passcode, when one is set."""
    expected = svc.settings.demo_passcode
    if expected and not secrets.compare_digest(x_demo_passcode.encode(), expected.encode()):
        raise HTTPException(401, "bad_passcode")


Passcode = Depends(require_passcode)
