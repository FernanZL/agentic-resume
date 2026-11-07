"""The OpenRouter model, streamed as LangGraph streams it: its cost reaches the budget and
its reasoning reaches the trace."""

import json

import httpx
import openrouter
from langchain_core.callbacks import AsyncCallbackHandler
from langchain_core.messages import HumanMessage
from langchain_core.outputs import LLMResult
from langgraph.graph import START, MessagesState, StateGraph

from agent.llm import chat_model
from backend.budget import usage_from

USAGE = {"prompt_tokens": 12, "completion_tokens": 5, "total_tokens": 17, "cost": 3.7e-06}


def sse(*chunks: dict) -> bytes:
    return b"".join(f"data: {json.dumps(c)}\n\n".encode() for c in chunks) + b"data: [DONE]\n\n"


def openrouter_api(_: httpx.Request) -> httpx.Response:
    """OpenRouter's stream: reasoning deltas, the answer, then the usage with its cost."""
    base = {"id": "gen-1", "object": "chat.completion.chunk", "created": 0, "model": "m"}

    def delta(**fields) -> dict:
        return {**base, "choices": [{"index": 0, "delta": fields, "finish_reason": None}]}

    body = sse(
        delta(role="assistant", content="", reasoning="391 is 17 x 23, "),
        delta(content="", reasoning="so not prime."),
        delta(content="No"),
        {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
        {**base, "choices": [], "usage": USAGE},
    )
    return httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})


async def test_a_call_streamed_by_langgraph_reports_its_cost_and_reasoning():
    """As in a run: LangGraph's "messages" mode makes the model stream, and callbacks
    (the cost recorder, the trace) get the merged reply."""
    ended: list[LLMResult] = []

    class Recorder(AsyncCallbackHandler):
        async def on_llm_end(self, response: LLMResult, **kwargs) -> None:
            ended.append(response)

    async with httpx.AsyncClient(transport=httpx.MockTransport(openrouter_api)) as http:
        model = chat_model("m", "k", name="answer")
        model.client = openrouter.OpenRouter(api_key="k", async_client=http)

        async def answer(state: MessagesState) -> dict:
            return {"messages": [await model.ainvoke(state["messages"])]}

        graph = StateGraph(MessagesState).add_node(answer).add_edge(START, "answer").compile()
        streamed = [
            chunk.text
            async for chunk, _ in graph.astream(
                {"messages": [HumanMessage("Is 391 prime?")]},
                {"callbacks": [Recorder()]},
                stream_mode="messages",
            )
        ]

    assert "".join(streamed) == "No"
    (response,) = ended
    assert usage_from(response) == (12, 5, 3.7e-06)
    reply = response.generations[0][0].message
    assert reply.additional_kwargs["reasoning_content"] == "391 is 17 x 23, so not prime."
