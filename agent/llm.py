"""The models the agents work with, through OpenRouter (an OpenAI-compatible API that
reports each call's cost in its usage), and the one way to ask a model for a
structured answer."""

from dataclasses import dataclass
from typing import NamedTuple

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import BaseMessage
from langchain_core.runnables import Runnable, RunnableLambda
from langchain_openai import ChatOpenAI
from pydantic import BaseModel, SecretStr

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
MODEL_TIMEOUT = 120
RETRIES = 3


def chat_model(model: str, api_key: str, temperature: float = 0.2) -> ChatOpenAI:
    """A model on OpenRouter, asking it to report each call's cost in its usage."""
    return ChatOpenAI(
        model=model,
        base_url=OPENROUTER_BASE_URL,
        api_key=SecretStr(api_key),
        temperature=temperature,
        timeout=MODEL_TIMEOUT,
        max_retries=RETRIES,
        extra_body={"usage": {"include": True}},
        default_headers={"X-Title": "Agentic Resume"},
    )


class StopRun(RuntimeError):
    """An error that must end the whole run (e.g. the budget is spent): nodes and tools
    never catch it."""


class NoStructuredAnswer(ValueError):
    """The model answered in prose instead of with the schema."""


def structured[T: BaseModel](model: BaseChatModel, schema: type[T]) -> Runnable:
    """The model, answering with an instance of the schema, or raising NoStructuredAnswer.
    Function calling is the method most OpenRouter models support."""
    if isinstance(model, ChatOpenAI):
        answering = model.with_structured_output(schema, method="function_calling")
    else:
        answering = model.with_structured_output(schema)

    def required(answer: T | None) -> T:
        if answer is None:
            raise NoStructuredAnswer(f"The model gave no {schema.__name__}.")
        return answer

    return answering | RunnableLambda(required)


@dataclass(frozen=True)
class Models:
    """The model each role uses. The roles can share one model; tests give stubs."""

    concierge: BaseChatModel  # chats with the user, decides when to analyze
    intake: BaseChatModel  # turns document text into structure
    researcher: BaseChatModel  # job, company, market research with tools
    analyst: BaseChatModel  # LinkedIn audit, gap rubric
    writer: BaseChatModel  # resume and LinkedIn rewrites
    critic: BaseChatModel  # judges the rewrites


class Usage(NamedTuple):
    """A model call's tokens and its cost in US dollars."""

    input_tokens: int
    output_tokens: int
    cost: float


def usage_of(message: BaseMessage) -> Usage:
    """A reply's tokens and cost, as OpenRouter reports them (zero when it doesn't)."""
    usage = message.response_metadata.get("token_usage") or {}
    return Usage(
        int(usage.get("prompt_tokens") or 0),
        int(usage.get("completion_tokens") or 0),
        float(usage.get("cost") or 0.0),
    )
