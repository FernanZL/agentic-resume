"""Tracing: what a run's trace is told, and what reaches Langfuse. The real tracer is
exported into memory, through Langfuse's own export path (our hook and filter)."""

import asyncio
import json
import uuid
from contextlib import contextmanager
from types import SimpleNamespace

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.tools import tool
from langgraph.types import Command
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from agent.tests import stubs
from backend.tracing import (
    NOISE,
    OBSERVATION_TYPE,
    TOOL_FAILED,
    LangfuseRunTrace,
    LangfuseTracer,
    RunTrace,
    Tracer,
    mask_text,
    patch_spans,
    run_input,
    without_encrypted_reasoning,
)

EMAIL = "alex.rivera@example.com"  # in stubs.RESUME


def test_contact_details_are_masked_but_dates_are_not():
    text = "Ana Ruiz · ana.ruiz+jobs@mail.co.uk · +54 9 11 4567-8901 · (415) 555-0132\n2019 - 2023"
    masked = mask_text(text)
    assert "ana.ruiz" not in masked
    assert "4567" not in masked
    assert "555" not in masked
    assert masked.count("[email]") == 1
    assert masked.count("[phone]") == 2
    assert "2019 - 2023" in masked


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("call 4567 8901", "call [phone]"),  # eight digits: a national number
        ("+54 9 11 4567-8901, +1 415 555 0132", "[phone], [phone]"),
        ("2019-2023 and 2019 – 2023", "2019-2023 and 2019 – 2023"),
        ("since 2023-01-15", "since 2023-01-15"),
        ("40 services, 1.2.3, $1,200,000", "40 services, 1.2.3, $1,200,000"),
        ("run 080dd5a1-cd63-4cd6-9326-285269776f0b", "run 080dd5a1-cd63-4cd6-9326-285269776f0b"),
    ],
)
def test_phone_numbers_are_masked_and_dates_and_ids_kept(text, expected):
    assert mask_text(text) == expected


def test_the_export_hook_masks_and_types_subagents():
    spans = {
        "s1": SimpleNamespace(
            name="x",
            attributes={
                "langfuse.observation.input": "mail a@b.io",
                "langfuse.observation.metadata.note": "a@b.io",
                "session.id": "a@b.io",  # an id is never rewritten
                "count": 3,
            },
        ),
        "s2": SimpleNamespace(name="market_analyst", attributes={"output": "ok"}),
        "s3": SimpleNamespace(name="y", attributes={"output": "ok"}),
    }
    patches = patch_spans(params=SimpleNamespace(spans=spans)).span_patches
    assert patches["s1"].set_attributes == {
        "langfuse.observation.input": "mail [email]",
        "langfuse.observation.metadata.note": "[email]",
    }
    assert patches["s2"].set_attributes == {"langfuse.observation.type": "agent"}
    assert "s3" not in patches


def test_reasoning_summaries_are_kept_and_encrypted_reasoning_dropped():
    output = {
        "role": "assistant",
        "content": "No",
        "additional_kwargs": {
            "reasoning_content": "391 is 17 × 23.",
            "reasoning_details": [
                {"type": "reasoning.summary", "summary": "391 is 17 × 23."},
                {"type": "reasoning.encrypted", "data": "gAAAA" * 500},
            ],
        },
    }
    cleaned = json.loads(without_encrypted_reasoning(json.dumps(output)))
    kwargs = cleaned["additional_kwargs"]
    summary = "391 is 17 × 23."
    assert kwargs["reasoning_content"] == summary
    assert kwargs["reasoning_details"] == [{"type": "reasoning.summary", "summary": summary}]
    for text in ("plain text", "not json, reasoning.encrypted"):
        assert without_encrypted_reasoning(text) == text


def test_the_trace_input_is_the_message_not_the_documents():
    shown = run_input(stubs.first_input())
    assert set(shown) == {"message", "target"}
    assert stubs.first_input()["documents"]["resume"] not in str(shown)
    assert run_input({"messages": [HumanMessage("thanks")]}) == {"message": "thanks"}
    assert run_input(Command(resume={"decisions": {}})) == {"decisions": {}}
    assert run_input(None) is None


class Recording(Tracer):
    def __init__(self):
        self.runs: list[tuple[str, str]] = []
        self.outcomes: list[tuple[str, object]] = []

    @contextmanager
    def run(self, session_id, run_id, kind, payload):
        self.runs.append((session_id, kind))
        tracer = self

        class Trace(RunTrace):
            def finish(self, output):
                tracer.outcomes.append(("finish", output))

            def fail(self, error):
                tracer.outcomes.append(("fail", error))

        yield Trace()


async def test_each_run_reports_its_outcome_to_the_tracer(services):
    services.runner.tracer = tracer = Recording()
    await services.db.add_session("s1", {"title": "x"}, False)
    await services.runner.start("s1", "message", {"messages": [HumanMessage("hello")]})
    await services.runner.wait("s1")
    assert tracer.runs == [("s1", "message")]
    (kind, output), *_ = tracer.outcomes
    assert kind == "finish"
    assert output["status"] == "idle"
    assert output["reply"]


async def test_a_failed_run_is_traced_with_its_code(services, script):
    services.runner.tracer = tracer = Recording()
    await services.db.add_session("s1", {"title": "x"}, False)
    script.overrides["concierge"] = lambda messages: (_ for _ in ()).throw(ValueError("boom"))
    await services.runner.start("s1", "message", stubs.first_input())
    await services.runner.wait("s1")
    assert tracer.outcomes == [("fail", "internal_error")]


@pytest.fixture
def langfuse():
    """The real tracer, exporting into memory instead of to Langfuse."""
    exporter = InMemorySpanExporter()
    tracer = LangfuseTracer(
        public_key=f"pk-test-{uuid.uuid4()}",
        secret_key="sk-test",
        base_url="http://langfuse.invalid",
        span_exporter=exporter,
        tracer_provider=TracerProvider(),
    )
    yield tracer, exporter
    tracer.shutdown()


def exported(tracer: LangfuseTracer, exporter: InMemorySpanExporter) -> list:
    tracer.client.flush()
    return list(exporter.get_finished_spans())


async def run_session(services, session_id: str, kind: str, payload) -> None:
    await services.db.add_session(session_id, {"title": "x"}, False)
    await services.runner.start(session_id, kind, payload)
    await services.runner.wait(session_id)


async def test_a_run_is_one_nested_masked_trace_without_noise(services, langfuse):
    tracer, exporter = langfuse
    services.runner.tracer = tracer
    await run_session(services, "s1", "start", stubs.first_input())

    spans = exported(tracer, exporter)
    (root,) = [s for s in spans if s.parent is None]
    assert root.name == "start-session"
    assert {s.context.trace_id for s in spans} == {root.context.trace_id}
    assert {s.attributes.get("session.id") for s in spans} == {"s1"}
    assert not NOISE & {s.name for s in spans}
    agents = {s.name for s in spans if s.attributes.get(OBSERVATION_TYPE) == "agent"}
    assert {"start-session", "job_analyst", "market_analyst"} <= agents
    attributes = json.dumps([dict(s.attributes) for s in spans], ensure_ascii=False)
    assert EMAIL not in attributes
    assert "[email]" in attributes  # the resume reached the models, masked


async def test_a_failure_is_named_by_its_type_not_its_message(services, script, langfuse):
    tracer, exporter = langfuse
    services.runner.tracer = tracer
    leak = f"boom, see {EMAIL} and the resume"
    script.overrides["concierge"] = lambda messages: (_ for _ in ()).throw(ValueError(leak))
    await run_session(services, "s1", "message", stubs.first_input())

    spans = exported(tracer, exporter)
    for span in spans:
        assert "boom" not in json.dumps(dict(span.attributes))
        assert "boom" not in (span.status.description or "")
    (root,) = [s for s in spans if s.parent is None]
    assert root.attributes["langfuse.observation.status_message"] == "internal_error"
    assert any(s.status.description == "ValueError" for s in spans)


async def test_a_failed_tool_is_traced_without_its_text(services, script, langfuse):
    tracer, exporter = langfuse
    services.runner.tracer = tracer

    def concierge(messages):  # asks for a report kind that doesn't exist, quoting an email
        if isinstance(messages[-1], HumanMessage):
            return stubs.call("get_report", kind=f"bogus {EMAIL}")
        return AIMessage("Sorry, I couldn't open that report.")

    script.overrides["concierge"] = concierge
    await run_session(services, "s1", "message", {"messages": [HumanMessage("report?")]})

    spans = exported(tracer, exporter)
    (tool,) = [s for s in spans if s.name == "get_report"]
    assert tool.status.description == "ValidationError"
    for span in spans:
        assert "bogus" not in (span.status.description or "")  # statuses carry no text
        assert EMAIL not in json.dumps(dict(span.attributes))
    seen = (await services.runner.graph.aget_state({"configurable": {"thread_id": "s1"}})).values
    (result,) = [m for m in seen["messages"] if isinstance(m, ToolMessage)]
    assert "kind" in result.content  # the model is told what to fix in its call


async def test_a_tool_returning_an_error_is_traced_without_its_text(langfuse):
    tracer, exporter = langfuse

    @tool
    def lookup(query: str) -> ToolMessage:
        """Fails with a message quoting its input."""
        return ToolMessage(f"no match for {EMAIL}", tool_call_id="c1", status="error")

    with tracer.run("s1", "r1", "message", None) as trace:
        call = {"type": "tool_call", "name": "lookup", "args": {"query": "x"}, "id": "c1"}
        await lookup.ainvoke(call, config={"callbacks": trace.callbacks})

    (span,) = [s for s in exported(tracer, exporter) if s.name == "lookup"]
    assert span.status.description == TOOL_FAILED
    assert EMAIL not in json.dumps(dict(span.attributes))


async def test_concurrent_sessions_keep_their_own_traces(services, langfuse):
    tracer, exporter = langfuse
    services.runner.tracer = tracer
    await asyncio.gather(
        run_session(services, "s1", "start", stubs.first_input()),
        run_session(services, "s2", "start", stubs.first_input()),
    )
    spans = exported(tracer, exporter)
    roots = {s.context.trace_id: s for s in spans if s.parent is None}
    assert len(roots) == 2
    for span in spans:
        assert span.attributes.get("session.id") == roots[span.context.trace_id].attributes.get(
            "session.id"
        )


async def test_tracing_failures_never_fail_a_run(services, langfuse, monkeypatch):
    tracer, _ = langfuse
    services.runner.tracer = tracer

    def broken(*args, **kwargs):
        raise RuntimeError("Langfuse is down")

    monkeypatch.setattr(tracer.client, "start_as_current_observation", broken)
    await run_session(services, "s1", "message", {"messages": [HumanMessage("hello")]})
    assert (await services.db.get_session("s1"))["status"] == "idle"

    trace = LangfuseRunTrace(SimpleNamespace(update=broken), handler=None)
    trace.finish({"status": "idle"})  # logged, not raised
    trace.fail("internal_error")


async def test_a_trace_that_fails_to_end_doesnt_fail_its_run(services, langfuse, monkeypatch):
    tracer, _ = langfuse
    services.runner.tracer = tracer
    start = tracer._start

    def start_then_break_on_exit(stack, *args):
        trace = start(stack, *args)
        stack.callback(lambda: (_ for _ in ()).throw(RuntimeError("exit failed")))
        return trace

    monkeypatch.setattr(tracer, "_start", start_then_break_on_exit)
    await run_session(services, "s1", "message", {"messages": [HumanMessage("hello")]})
    assert (await services.db.get_session("s1"))["status"] == "idle"
    events = [e["type"] for e in await services.db.events_after("s1", 0)]
    assert "run_completed" in events
    assert "run_failed" not in events
