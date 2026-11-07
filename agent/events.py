"""How nodes tell the live timeline what they are doing: custom stream events that the
backend turns into SSE events. Outside a streamed run they go nowhere."""

import functools
import time
from collections.abc import Awaitable, Callable
from typing import Any

from langgraph.config import get_stream_writer

# The label the timeline shows for each step.
LABELS = {
    "concierge": "Assistant",
    "intake": "Reading your documents",
    "job_analyst": "Analyzing the job posting",
    "company_researcher": "Researching the company",
    "market_analyst": "Scanning the market",
    "linkedin_auditor": "Auditing your LinkedIn",
    "gap_analysis": "Measuring the gap",
    "resume_writer": "Rewriting the resume",
    "linkedin_writer": "Rewriting LinkedIn",
    "critic": "Fact-checking the rewrites",
    "review": "Waiting for your review",
    "finalize": "Applying your decisions",
}


def emit(type_: str, node: str, **data: Any) -> None:
    """Send one event to the run's stream."""
    try:
        writer = get_stream_writer()
    except RuntimeError:  # not inside a graph run (a unit test calling a helper)
        return
    writer({"type": type_, "node": node, "data": data})


def step[**P, R](node: str) -> Callable[[Callable[P, Awaitable[R]]], Callable[P, Awaitable[R]]]:
    """Mark an async node as a timeline step: announce its start and its finish."""

    def decorate(func: Callable[P, Awaitable[R]]) -> Callable[P, Awaitable[R]]:
        @functools.wraps(func)
        async def run(*args: P.args, **kwargs: P.kwargs) -> R:
            label = LABELS.get(node, node)
            emit("node_started", node, label=label)
            began = time.monotonic()
            result = await func(*args, **kwargs)
            emit("node_finished", node, label=label, seconds=round(time.monotonic() - began, 1))
            return result

        return run

    return decorate
