"""Tracing of runs in Langfuse: one trace per run, grouped by session. Contact details are
masked and failures are named by type before anything leaves the process, the research
subagents are typed as agents and LangChain's plumbing is left out. The models' reasoning
summaries are kept (in each generation's `additional_kwargs.reasoning_content`); their
encrypted reasoning, unreadable and half the bytes, is not. Tracing only observes: it
never raises into a run. Without Langfuse keys it does nothing."""

import json
import logging
import re
from collections.abc import Iterator
from contextlib import ExitStack, contextmanager
from typing import Any

from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.messages import BaseMessage, ToolMessage
from langfuse import Langfuse, is_default_export_span, propagate_attributes
from langfuse.langchain import CallbackHandler
from langfuse.types import MaskOtelSpansParams, MaskOtelSpansResult, OtelSpanPatch
from langgraph.types import Command
from opentelemetry.sdk.trace import ReadableSpan

from backend.errors import describe

log = logging.getLogger(__name__)

# Trace names are filtered on and targeted by evaluators: keep them stable.
TRACE_NAMES = {
    "start": "start-session",
    "message": "answer-message",
    "review": "apply-review",
    "resume": "resume-run",
}
EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
# A run of digits and separators, not glued to letters, digits or hyphens (a UUID's or a
# hash's digit runs aren't phones). Eight digits or more is a phone, unless it is a date.
PHONE = re.compile(r"(?<![\w-])\+?\(?\d[\d ().-]{6,}\d(?![\w-])")
PHONE_MIN_DIGITS = 8
NOT_PHONE = re.compile(r"(?:19|20)\d\d\s*[-–]\s*(?:19|20)\d\d|\d{4}-\d\d-\d\d")  # 2019 - 2023
# The attributes that carry content (documents, messages, errors); ids and names are not.
CONTENT = ("input", "output", "metadata", "status_message")
# Leaf spans that only say LangChain is working: output parsers, edge routers, and the
# Tavily call inside our web_search tool (whose own span already holds the results).
NOISE = frozenset(
    {"_check_refusal", "PydanticToolsParser", "required", "tavily_search"}
    | {"after_concierge", "after_tools", "after_critic"}
)
SUBAGENTS = frozenset({"job_analyst", "company_researcher", "market_analyst", "linkedin_auditor"})
OBSERVATION_TYPE = "langfuse.observation.type"
ENCRYPTED_REASONING = "reasoning.encrypted"  # OpenRouter's opaque reasoning_details entry
TOOL_FAILED = "The tool failed."  # a failed tool's result, as traced


def mask_text(text: str) -> str:
    """The text with email addresses and phone numbers redacted."""
    return PHONE.sub(_phone_masked, EMAIL.sub("[email]", text))


def _phone_masked(match: re.Match) -> str:
    candidate = match[0]
    digits = sum(c.isdigit() for c in candidate)
    if digits < PHONE_MIN_DIGITS or NOT_PHONE.fullmatch(candidate):
        return candidate
    return "[phone]"


def without_encrypted_reasoning(text: str) -> str:
    """A serialized input or output without the encrypted reasoning entries."""
    if ENCRYPTED_REASONING not in text:
        return text
    try:
        data = json.loads(text)
    except ValueError:
        return text
    return json.dumps(_drop_encrypted(data), ensure_ascii=False)


def _drop_encrypted(node: Any) -> Any:
    if isinstance(node, dict):
        return {key: _drop_encrypted(value) for key, value in node.items()}
    if isinstance(node, list):
        return [
            _drop_encrypted(item)
            for item in node
            if not (isinstance(item, dict) and item.get("type") == ENCRYPTED_REASONING)
        ]
    return node


def _is_content(key: str) -> bool:
    """`langfuse.observation.input`, `langfuse.trace.metadata.x` and the like."""
    parts = key.split(".")
    return parts[0] == "langfuse" and len(parts) > 2 and parts[2] in CONTENT


def _cleaned(key: str, value: Any) -> Any:
    """An attribute as it may leave the process: content trimmed and masked."""
    if not (isinstance(value, str) and _is_content(key)):
        return value
    return mask_text(without_encrypted_reasoning(value))


def should_export_span(span: ReadableSpan) -> bool:
    """Langfuse's export filter: its default one, without the noise."""
    return is_default_export_span(span) and span.name not in NOISE


def patch_spans(*, params: MaskOtelSpansParams) -> MaskOtelSpansResult:
    """Langfuse's export hook: content attributes cleaned (see _cleaned), and each
    research subagent typed `agent` (LangGraph nodes arrive as chains) so the agent graph
    shows them."""
    patches = {}
    for identifier, span in params.spans.items():
        changed: dict[str, Any] = {
            key: cleaned
            for key, value in span.attributes.items()
            if (cleaned := _cleaned(key, value)) != value
        }
        if span.name in SUBAGENTS:
            changed[OBSERVATION_TYPE] = "agent"
        if changed:
            patches[identifier] = OtelSpanPatch(set_attributes=changed)
    return MaskOtelSpansResult(span_patches=patches)


def run_input(payload: Any) -> Any:
    """What a reviewer needs to see as the run's input: the user's message (and target)
    or review decisions, never the whole graph input with the documents."""
    if isinstance(payload, Command):
        return payload.resume
    if not isinstance(payload, dict):
        return None
    shown: dict[str, Any] = {}
    if messages := payload.get("messages"):
        last = messages[-1]
        shown["message"] = last.text if isinstance(last, BaseMessage) else str(last)
    if target := payload.get("target"):
        shown["target"] = target.model_dump() if hasattr(target, "model_dump") else target
    return shown or None


class RunTrace:
    """One run's trace: the callbacks to hand the graph, and its outcome. This base one
    records nothing."""

    def __init__(self, callbacks: list[BaseCallbackHandler] | None = None):
        self.callbacks = callbacks or []

    def finish(self, output: Any) -> None:
        """Record the run's output."""

    def fail(self, error: str) -> None:
        """Record that the run failed, with the error code the user is shown."""


class Tracer:
    """Traces nothing (no Langfuse keys, and tests)."""

    @contextmanager
    def run(self, session_id: str, run_id: str, kind: str, payload: Any) -> Iterator[RunTrace]:
        yield RunTrace()

    def shutdown(self) -> None:
        """Send what is still queued."""


class RedactingCallbackHandler(CallbackHandler):
    """LangChain's Langfuse handler, recording a failure without its text. It would put an
    exception's message, or a failed tool's result, in the observation's status, which can
    quote the user's documents and which no export hook can rewrite."""

    def _get_error_level_and_status_message(self, error: BaseException) -> tuple[Any, str]:
        level, _ = super()._get_error_level_and_status_message(error)
        return level, describe(error)

    def on_tool_end(self, output: Any, **kwargs: Any) -> Any:
        if isinstance(output, ToolMessage) and output.status == "error":
            output = output.model_copy(update={"content": TOOL_FAILED})
        return super().on_tool_end(output, **kwargs)


class LangfuseRunTrace(RunTrace):
    def __init__(self, root: Any, handler: BaseCallbackHandler):
        super().__init__([handler])
        self.root = root

    def finish(self, output: Any) -> None:
        self._update(output=output)

    def fail(self, error: str) -> None:
        self._update(level="ERROR", status_message=error, output={"error": error})

    def _update(self, **fields: Any) -> None:
        try:
            self.root.update(**fields)
        except Exception as error:  # noqa: BLE001  a trace never fails a run
            log.warning("Tracing failed to record a run's outcome: %s", describe(error))


class LangfuseTracer(Tracer):
    """Each run as a root `agent` observation, with LangChain's handler nested under it
    (it records every node, model call and tool call). Tests pass `span_exporter` and
    `tracer_provider` to keep spans in memory."""

    def __init__(self, **client_options: Any):
        self.public_key = client_options.get("public_key")
        self.client = Langfuse(
            mask_otel_spans=patch_spans, should_export_span=should_export_span, **client_options
        )

    @contextmanager
    def run(self, session_id: str, run_id: str, kind: str, payload: Any) -> Iterator[RunTrace]:
        stack = ExitStack()
        try:
            trace = self._start(stack, session_id, run_id, kind, payload)
        except Exception as error:  # noqa: BLE001  the run goes on untraced
            log.warning("Tracing failed to start a run: %s", describe(error))
            self._close(stack)
            trace = RunTrace()
        try:
            yield trace
        finally:
            self._close(stack)

    def _start(
        self, stack: ExitStack, session_id: str, run_id: str, kind: str, payload: Any
    ) -> RunTrace:
        name = TRACE_NAMES.get(kind, "run-session")
        stack.enter_context(
            propagate_attributes(session_id=session_id, trace_name=name, tags=[kind])
        )
        root = stack.enter_context(
            self.client.start_as_current_observation(
                as_type="agent",
                name=name,
                input=run_input(payload),
                metadata={"app_run_id": run_id, "kind": kind},
            )
        )
        return LangfuseRunTrace(root, RedactingCallbackHandler(public_key=self.public_key))

    @staticmethod
    def _close(stack: ExitStack) -> None:
        """End the root observation. The run's own error, if any, is not handed to it:
        its outcome was recorded by fail(), and its message must not be."""
        try:
            stack.close()
        except Exception as error:  # noqa: BLE001  a trace never fails a run
            log.warning("Tracing failed to end a run: %s", describe(error))

    def shutdown(self) -> None:
        try:
            self.client.shutdown()
        except Exception as error:  # noqa: BLE001  shutting down goes on regardless
            log.warning("Tracing failed to flush: %s", describe(error))
