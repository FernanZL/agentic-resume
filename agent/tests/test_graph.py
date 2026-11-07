"""The session graph end to end on stub models: routing, fan-out, the critic loop, the
review pause inside the subgraph, re-analysis and revisions."""

import itertools

import pytest
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.types import Command

from agent.checkpoints import memory_saver
from agent.graph import build_graph, run_config
from agent.nodes.review import resume_with
from agent.render import apply_decisions, profile_markdown
from agent.schemas import Action, Decision, ProposalStatus, TargetJob
from agent.state import RunContext
from agent.tests import stubs
from agent.tools.fetch_url import FetchResult

CONTEXT = RunContext(session_id="s1", run_id="r1")


def graph_on(script=None, fetched=None):
    return build_graph(stubs.models(script), stubs.toolbox(fetched), memory_saver())


async def run(graph, payload, thread="s1"):
    events = []
    async for _, mode, chunk in graph.astream(
        payload,
        run_config(thread, "r1"),
        context=CONTEXT,
        stream_mode=["custom", "updates"],
        subgraphs=True,
    ):
        if mode == "custom":
            events.append(chunk)
    return events


async def analysis_state(graph, thread="s1"):
    """The values inside the paused analysis subgraph."""
    state = await graph.aget_state(run_config(thread, "r1"), subgraphs=True)
    return state, state.tasks[0].state.values


async def test_a_session_runs_research_writes_checks_and_pauses_for_review():
    graph = graph_on()
    events = await run(graph, stubs.first_input())

    state, analysis = await analysis_state(graph)
    assert state.next == ("analysis",)
    assert state.interrupts[0].value["proposal_ids"] == sorted(analysis["proposals"])
    assert set(analysis["reports"]) == {"job", "market", "company", "linkedin"}
    assert all(not report.error for report in analysis["reports"].values())
    # The ghost target is dropped; the unsupported 40% went back to the writer once.
    assert set(analysis["proposals"]) == {"resume:summary", "resume:exp1.b0", "linkedin:headline"}
    rewritten = analysis["proposals"]["resume:exp1.b0"]
    assert "[X]%" in rewritten.proposed
    assert rewritten.status is ProposalStatus.OK
    assert analysis["critique_rounds"] == 2
    assert analysis["gap"].weak_bullets == ["exp1.b0"]  # the made-up id is filtered out
    assert analysis["profile"].experience[0].bullets[1].id == "exp0.b1"
    types = [event["type"] for event in events]
    assert types.count("report_ready") == 4
    assert "gap_ready" in types
    assert "critique" in types


async def test_the_review_resumes_through_the_parent_and_finalizes():
    graph = graph_on()
    await run(graph, stubs.first_input())
    decisions = {
        "resume:summary": {"action": "accept", "text": ""},
        "resume:exp1.b0": {"action": "edit", "text": "Owned the checkout service."},
        "linkedin:headline": {"action": "reject", "text": ""},
        "resume:not-a-proposal": {"action": "accept", "text": ""},
    }
    await run(graph, Command(resume=resume_with(decisions)))

    state = await graph.aget_state(run_config("s1", "r1"))
    values = state.values
    assert state.next == ()
    assert values["analyzed"] is True
    assert set(values["decisions"]) == {"resume:summary", "resume:exp1.b0", "linkedin:headline"}
    assert isinstance(values["messages"][-1], AIMessage)
    final = apply_decisions(
        values["profile"], values["linkedin"], values["proposals"], values["decisions"]
    )
    assert final.resume.summary.startswith("Backend engineer with 6 years building high-volume")
    assert final.resume.experience[1].bullets[0].text == "Owned the checkout service."
    assert final.linkedin["headline"] == "Engineer at Fintech Co"  # rejected: unchanged
    assert "## Experience" in profile_markdown(final.resume)


async def test_research_is_planned_from_what_is_known():
    graph = graph_on()
    target = TargetJob(title="Data Engineer")
    await run(graph, stubs.first_input(linkedin=False, target=target))
    _, analysis = await analysis_state(graph)
    assert set(analysis["reports"]) == {"job", "market"}
    assert analysis["linkedin"] is None


async def test_a_failing_researcher_reports_its_error_and_the_run_goes_on():
    script = stubs.Script(linkedin_auditor=lambda messages: AIMessage(content="not structured"))
    graph = graph_on(script)
    await run(graph, stubs.first_input())
    _, analysis = await analysis_state(graph)
    assert analysis["reports"]["linkedin"].error
    assert analysis["gap"] is not None


async def test_a_posting_url_is_fetched_in_code_and_marked_untrusted():
    script = stubs.Script()
    graph = graph_on(script, FetchResult(url="https://jobs.example/1", ok=True, text="Kafka!"))
    target = TargetJob(title="Staff Engineer", job_url="https://jobs.example/1")
    events = await run(graph, stubs.first_input(target=target))
    tool_events = [e for e in events if e["type"] == "tool_called" and e["node"] == "job_analyst"]
    assert tool_events[0]["data"]["tool"] == "fetch_url"


async def test_reanalysis_replaces_old_results_and_routes_once():
    script = stubs.Script()
    graph = graph_on(script)
    await run(graph, stubs.first_input())
    await run(graph, Command(resume=resume_with({})))
    analysis_runs = script.critic_rounds
    await run(graph, {"messages": [HumanMessage("Now try Platform Engineer at Initech")]})

    state, analysis = await analysis_state(graph)
    assert state.next == ("analysis",)
    assert script.critic_rounds > analysis_runs
    parent = state.values
    assert parent["proposals"] == {}
    assert parent["decisions"] == {}
    assert not parent["analyzed"]
    assert set(analysis["proposals"]) == {"resume:summary", "resume:exp1.b0", "linkedin:headline"}


async def test_revising_a_proposal_after_review_accepts_the_checked_rewrite():
    turns = itertools.count()

    def concierge(messages):
        if isinstance(messages[-1], HumanMessage):
            if next(turns) == 0:
                return stubs.call("request_analysis", title="Staff Backend Engineer")
            return stubs.call(
                "revise_proposal", proposal_id="linkedin:headline", instruction="Shorter please"
            )
        return AIMessage(content="Done.")

    def linkedin_writer(messages):
        if "Return exactly one proposal" in messages[-1].content:
            return stubs.call(
                "Draft",
                target="whatever",
                proposed="Backend Engineer | 99% uptime",
                rationale="Shorter",
            )
        return stubs.Script().linkedin_writer(messages)

    graph = graph_on(stubs.Script(concierge=concierge, linkedin_writer=linkedin_writer))
    await run(graph, stubs.first_input())
    await run(
        graph, Command(resume=resume_with({"linkedin:headline": {"action": "reject", "text": ""}}))
    )
    await run(graph, {"messages": [HumanMessage("Make the headline shorter")]})

    values = (await graph.aget_state(run_config("s1", "r1"))).values
    revised = values["proposals"]["linkedin:headline"]
    assert revised.proposed == "Backend Engineer | [X] uptime"  # 99% wasn't in the documents
    assert revised.status is ProposalStatus.FLAGGED
    assert values["decisions"]["linkedin:headline"] == Decision(action=Action.ACCEPT)


async def test_the_concierge_stops_after_its_call_limit():
    script = stubs.Script(concierge=lambda messages: stubs.call("get_report", kind="gap"))
    graph = graph_on(script)
    await run(graph, {**stubs.first_input(), "messages": [HumanMessage("hi")]})
    messages = (await graph.aget_state(run_config("s1", "r1"))).values["messages"]
    assert messages[-1].content.startswith("I've done as much as I can")


@pytest.mark.parametrize("cancelled", [resume_with({}), {"unexpected": 1}])
async def test_a_review_with_no_decisions_rejects_everything(cancelled):
    graph = graph_on()
    await run(graph, stubs.first_input())
    await run(graph, Command(resume=cancelled))
    values = (await graph.aget_state(run_config("s1", "r1"))).values
    assert values["analyzed"] is True
    assert values["decisions"] == {}


async def test_a_proposal_the_critic_skips_is_not_passed():
    script = stubs.Script(critic=lambda messages: stubs.call("Verdicts", verdicts=[]))
    graph = graph_on(script)
    await run(graph, stubs.first_input())
    _, analysis = await analysis_state(graph)
    assert analysis["critique_rounds"] == 3  # kept going to the last round
    summary = analysis["proposals"]["resume:summary"]
    assert summary.status is ProposalStatus.FLAGGED
    assert "no verdict" in summary.issues[0]


async def test_a_rewrite_that_gives_up_withdraws_the_proposal():
    def resume_writer(messages):
        if "Critic feedback" in messages[-1].content:
            return stubs.call(
                "Drafts",
                proposals=[
                    {
                        "target": "exp1.b0",
                        "proposed": "Maintained checkout service",
                        "rationale": "-",
                    }
                ],
            )
        return stubs.Script().resume_writer(messages)

    graph = graph_on(stubs.Script(resume_writer=resume_writer))
    await run(graph, stubs.first_input())
    _, analysis = await analysis_state(graph)
    assert "resume:exp1.b0" not in analysis["proposals"]
