"""The session graph, one thread per session:

START → concierge ⇄ tools ─(route = analyze)─▶ analysis [subgraph] → concierge → END
"""

from typing import Any

from langchain_core.callbacks import BaseCallbackHandler
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph
from langgraph.prebuilt import ToolNode

from agent.analysis import MAX_CONCURRENCY, build_analysis
from agent.concierge import make_concierge, make_tools
from agent.llm import Models, StopRun
from agent.state import RunContext, SessionState
from agent.toolbox import Toolbox

RECURSION_LIMIT = 80


def tool_error(error: Exception) -> str:
    """A failing tool is reported to the concierge, unless the run must stop."""
    if isinstance(error, StopRun):
        raise error
    return f"The tool failed: {type(error).__name__}: {error}"


def after_concierge(state: SessionState) -> str:
    last = state["messages"][-1]
    return "tools" if getattr(last, "tool_calls", None) else END


def after_tools(state: SessionState) -> str:
    return "analysis" if state.get("route") == "analyze" else "concierge"


def build_graph(
    models: Models, toolbox: Toolbox, checkpointer: BaseCheckpointSaver | None
) -> CompiledStateGraph:
    """The session graph with the analysis graph as a native subgraph node."""
    tools = make_tools(models)
    builder = StateGraph(SessionState, context_schema=RunContext)
    builder.add_node("concierge", make_concierge(models, tools))
    builder.add_node("tools", ToolNode(tools, handle_tool_errors=tool_error))
    builder.add_node("analysis", build_analysis(models, toolbox))
    builder.add_edge(START, "concierge")
    builder.add_conditional_edges("concierge", after_concierge, ["tools", END])
    builder.add_conditional_edges("tools", after_tools, ["analysis", "concierge"])
    builder.add_edge("analysis", "concierge")
    return builder.compile(checkpointer=checkpointer, name="session")


def run_config(
    session_id: str, run_id: str, callbacks: list[BaseCallbackHandler] | None = None
) -> dict[str, Any]:
    """The config of one run of a session's graph."""
    return {
        "configurable": {"thread_id": session_id},
        "max_concurrency": MAX_CONCURRENCY,
        "recursion_limit": RECURSION_LIMIT,
        "callbacks": callbacks or [],
        "metadata": {
            "session_id": session_id,
            "app_run_id": run_id,
        },  # LangGraph uses "run_id" itself
        "run_name": "session",
    }
