"""The analysis subgraph: a deterministic map-reduce, where routing is code and the
models only work inside nodes.

intake → plan ─Send─▶ researchers (parallel) → gap_analysis → writers (parallel)
       → critic ⇄ writers (≤2 rewrites) → review (pause) → finalize
"""

from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph

from agent.llm import Models
from agent.nodes.critic import after_critic, make_critic
from agent.nodes.gap import make_gap_analysis
from agent.nodes.intake import make_intake
from agent.nodes.research import NODES as RESEARCHERS
from agent.nodes.research import RETRY, make_researcher, plan
from agent.nodes.review import finalize, review
from agent.nodes.writers import NODES as WRITERS
from agent.nodes.writers import make_writer
from agent.state import AnalysisState, RunContext
from agent.toolbox import Toolbox

# The most researchers working at once.
MAX_CONCURRENCY = 4


def build_analysis(models: Models, toolbox: Toolbox) -> CompiledStateGraph:
    """The analysis graph, compiled with no checkpointer of its own: as a subgraph it
    saves into its parent's checkpoints, which its review pause needs."""
    builder = StateGraph(AnalysisState, context_schema=RunContext)
    builder.add_node("intake", make_intake(models), retry_policy=RETRY)
    for kind, node in RESEARCHERS.items():
        builder.add_node(node, make_researcher(kind, models, toolbox), retry_policy=RETRY)
        builder.add_edge(node, "gap_analysis")
    builder.add_node("gap_analysis", make_gap_analysis(models), retry_policy=RETRY)
    for document, node in WRITERS.items():
        builder.add_node(node, make_writer(document, models), retry_policy=RETRY)
        builder.add_edge("gap_analysis", node)
        builder.add_edge(node, "critic")
    builder.add_node("critic", make_critic(models), retry_policy=RETRY)
    builder.add_node("review", review)
    builder.add_node("finalize", finalize)

    builder.add_edge(START, "intake")
    builder.add_conditional_edges("intake", plan, list(RESEARCHERS.values()))
    builder.add_conditional_edges("critic", after_critic, [*WRITERS.values(), "review"])
    builder.add_edge("review", "finalize")
    builder.add_edge("finalize", END)
    return builder.compile(name="analysis")
