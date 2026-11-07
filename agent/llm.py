"""The models the agents work with, through OpenRouter (LangChain's own integration,
which reports each call's cost and the model's reasoning), and the one way to ask a model
for a structured answer."""

from dataclasses import dataclass

from langchain_core.language_models import BaseChatModel
from langchain_core.runnables import Runnable, RunnableLambda
from langchain_openrouter import ChatOpenRouter
from pydantic import BaseModel, SecretStr

MODEL_TIMEOUT_MS = 120_000
RETRY_WINDOW = 1  # the SDK retries 5XX for ~150 s per unit; 429s and timeouts: RETRY


def chat_model(
    model: str, api_key: str, temperature: float = 0.2, name: str | None = None
) -> ChatOpenRouter:
    """A model on OpenRouter. The name is what traces call its calls (a step, never the
    model id, which changes)."""
    return ChatOpenRouter(
        name=name,
        model=model,
        api_key=SecretStr(api_key),
        temperature=temperature,
        timeout=MODEL_TIMEOUT_MS,
        max_retries=RETRY_WINDOW,
        app_title="Agentic Resume",
    )


class StopRun(RuntimeError):
    """An error that must end the whole run (e.g. the budget is spent): nodes and tools
    never catch it."""


class NoStructuredAnswer(ValueError):
    """The model answered in prose instead of with the schema."""


def structured[T: BaseModel](model: BaseChatModel, schema: type[T]) -> Runnable:
    """The model, answering with an instance of the schema, or raising NoStructuredAnswer.
    Function calling is the method most OpenRouter models support."""
    if isinstance(model, ChatOpenRouter):
        answering = model.with_structured_output(schema, method="function_calling")
    else:
        answering = model.with_structured_output(schema)

    def required(answer: T | None) -> T:
        if answer is None:
            raise NoStructuredAnswer(f"The model gave no {schema.__name__}.")
        return answer

    return (answering | RunnableLambda(required)).with_config(
        run_name=f"answer-as-{schema.__name__}"
    )


@dataclass(frozen=True)
class Models:
    """The model each role uses. The roles can share one model; tests give stubs."""

    concierge: BaseChatModel  # chats with the user, decides when to analyze
    intake: BaseChatModel  # turns document text into structure
    researcher: BaseChatModel  # job, company, market research with tools
    analyst: BaseChatModel  # LinkedIn audit, gap rubric
    writer: BaseChatModel  # resume and LinkedIn rewrites
    critic: BaseChatModel  # judges the rewrites
