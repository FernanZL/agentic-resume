"""The cost guard: a daily spending cap checked before every run and before every model
call, with a reservation held for each call in flight, so parallel branches can't
overspend together; and the recorder that writes each call's cost."""

import logging
from typing import Any
from uuid import UUID

from langchain_core.callbacks import AsyncCallbackHandler
from langchain_core.outputs import LLMResult

from agent.llm import StopRun
from backend.database import Database

log = logging.getLogger(__name__)


class BudgetExceeded(StopRun):
    """Today's spending cap is reached."""


class Budget:
    """The daily cap, shared by every run in the process (the app runs one worker)."""

    def __init__(self, db: Database, daily_limit: float, reservation: float):
        self.db = db
        self.daily_limit = daily_limit
        self.reservation = reservation
        self.in_flight = 0

    async def check(self) -> None:
        """Raise BudgetExceeded unless one more call fits: today's spend, plus what the
        calls in flight may cost, plus this call's reservation. A cap of 0 is off."""
        await self._fits(self.in_flight + 1)

    async def reserve(self) -> None:
        """Hold one call's reservation; it is released only once its cost is recorded."""
        self.in_flight += 1  # held during the check, so parallel calls see each other
        try:
            await self._fits(self.in_flight)
        except BaseException:
            self.in_flight -= 1
            raise

    async def _fits(self, reservations: int) -> None:
        if self.daily_limit <= 0:
            return
        spent = await self.db.spent_since(24)
        if spent + reservations * self.reservation > self.daily_limit:
            raise BudgetExceeded(f"Daily budget of ${self.daily_limit:.2f} reached")

    def release(self) -> None:
        self.in_flight = max(0, self.in_flight - 1)


def usage_from(response: LLMResult) -> tuple[int, int, float]:
    """Tokens and cost from a model call, wherever the provider put them."""
    usage: dict[str, Any] = dict((response.llm_output or {}).get("token_usage") or {})
    for generations in response.generations:
        for generation in generations:
            message = getattr(generation, "message", None)
            if message is None:
                continue
            usage = {**(message.response_metadata.get("token_usage") or {}), **usage}
            meta = message.usage_metadata or {}
            usage.setdefault("prompt_tokens", meta.get("input_tokens", 0))
            usage.setdefault("completion_tokens", meta.get("output_tokens", 0))
    return (
        int(usage.get("prompt_tokens") or 0),
        int(usage.get("completion_tokens") or 0),
        float(usage.get("cost") or 0.0),
    )


class CostRecorder(AsyncCallbackHandler):
    """Checks the budget before each model call of a run and records its cost after."""

    raise_error = True  # a BudgetExceeded must stop the call, not be logged and ignored

    def __init__(self, budget: Budget, session_id: str, run_id: str):
        self.budget = budget
        self.session_id = session_id
        self.run_id = run_id
        self.calls: dict[UUID, tuple[str, str]] = {}

    async def on_chat_model_start(
        self,
        serialized: dict,
        messages: list,
        *,
        run_id: UUID,
        metadata: dict | None = None,
        **kwargs: Any,
    ) -> None:
        await self.budget.reserve()
        metadata = metadata or {}
        node = str(metadata.get("langgraph_node", ""))
        model = str(metadata.get("ls_model_name", "") or (serialized or {}).get("name", ""))
        self.calls[run_id] = (node, model)

    async def on_llm_end(self, response: LLMResult, *, run_id: UUID, **kwargs: Any) -> None:
        if run_id not in self.calls:
            return
        node, model = self.calls.pop(run_id)
        input_tokens, output_tokens, cost = usage_from(response)
        try:
            await self.budget.db.add_model_call(
                self.session_id, self.run_id, node, model, input_tokens, output_tokens, cost
            )
        finally:  # the reservation covers the call until its cost is on record
            self.budget.release()

    async def on_llm_error(self, error: BaseException, *, run_id: UUID, **kwargs: Any) -> None:
        if self.calls.pop(run_id, None) is not None:
            self.budget.release()
