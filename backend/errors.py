"""What a failure is called outside the process: a code for the user, a type (and an API's
status) for logs and traces, never the exception's message, which can quote the user's
documents."""

import httpx
from langchain_core.exceptions import OutputParserException
from openrouter.errors import NoResponseError, OpenRouterError
from pydantic import ValidationError

from agent.llm import NoStructuredAnswer
from backend.budget import BudgetExceeded


def error_code(error: BaseException) -> str:
    """What the user is told a run failed of."""
    if isinstance(error, BudgetExceeded):
        return "budget_exceeded"
    if isinstance(error, NoStructuredAnswer | ValidationError | OutputParserException):
        return "invalid_model_output"
    if isinstance(error, OpenRouterError | NoResponseError | httpx.HTTPError):
        return "model_error"
    return "internal_error"


def describe(error: BaseException) -> str:
    """An exception without its message: its type, and an API's status."""
    status = getattr(error, "status_code", None)
    return f"{type(error).__name__}" + (f" (HTTP {status})" if status else "")
