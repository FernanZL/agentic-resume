"""Offline behavioral evaluations for persisted follow-ups and grounded keyword rewrites."""

import json

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.types import Command

from agent.checkpoints import memory_saver
from agent.concierge import current_documents, rerun_needs_permission
from agent.graph import build_graph, run_config
from agent.nodes.critic import keyword_issues
from agent.nodes.review import resume_with
from agent.render import assign_ids
from agent.schemas import CandidateProfile, Document, JobAnalysis, Proposal, Report, ReportKind
from agent.tests import stubs


def test_critic_catches_lost_keywords_even_if_the_model_passes_the_proposal():
    profile = CandidateProfile.model_validate(stubs.profile_args())
    assign_ids(profile, None)
    proposal = Proposal(
        id="resume:exp0.b1",
        document=Document.RESUME,
        target="exp0.b1",
        original=profile.experience[0].bullets[1].text,
        proposed="Led migration of 12 services.",
        rationale="Shorter",
    )
    state = {
        "profile": profile,
        "proposals": {proposal.id: proposal},
        "reports": {
            "job": Report(
                kind=ReportKind.JOB,
                job=JobAnalysis(summary="Backend role", keywords=["Kubernetes"]),
            )
        },
    }
    assert "Kubernetes" in keyword_issues(state, {proposal.id: proposal})[proposal.id][0]


def test_a_rerun_command_cannot_be_reused_after_review():
    messages = [HumanMessage("/reanalyze Backend Engineer")]
    assert not rerun_needs_permission({"analyzed": True, "messages": messages})
    messages.append(
        ToolMessage(
            "Analysis started for Backend Engineer.",
            name="request_analysis",
            tool_call_id="c1",
        )
    )
    assert rerun_needs_permission({"analyzed": True, "messages": messages})


@pytest.mark.parametrize(
    "message",
    [
        "Why didn't you add the missing keywords?",
        "Explain the match score.",
        "Make the summary stronger without starting over.",
        "Don't /reanalyze anything; explain the changes.",
        "What does /reanalyze mean?",
    ],
)
async def test_followups_cannot_replace_the_reviewed_session(message):
    # Deliberately misbehaving model: the tool must protect state even when the prompt fails.
    script = stubs.Script()
    graph = build_graph(stubs.models(script), stubs.toolbox(), memory_saver())
    config = run_config("followup", "eval")
    await graph.ainvoke(stubs.first_input(), config)
    await graph.ainvoke(
        Command(
            resume=resume_with(
                {
                    "resume:summary": {"action": "edit", "text": "My reviewed summary."},
                }
            )
        ),
        config,
    )
    before = (await graph.aget_state(config)).values
    rounds = script.critic_rounds
    await graph.ainvoke({"messages": [HumanMessage(message)]}, config)
    after = (await graph.aget_state(config)).values
    for key in ("reports", "proposals", "decisions", "gap", "target", "analyzed"):
        assert after[key] == before[key], key
    assert script.critic_rounds == rounds
    assert not (await graph.aget_state(config)).next
    assert any(
        "saved analysis was preserved" in m.text
        for m in after["messages"]
        if isinstance(m, ToolMessage)
    )
    assert "My reviewed summary." in current_documents(after)


async def test_assistant_reads_reviewed_text_and_current_coverage():
    seen = []

    def concierge(messages):
        if isinstance(messages[-1], HumanMessage) and messages[-1].text.startswith("Why"):
            return stubs.call("get_documents")
        if isinstance(messages[-1], ToolMessage) and messages[-1].name == "get_documents":
            seen.append(messages[-1].text)
            return AIMessage("Kafka still needs evidence; your saved summary was retained.")
        return stubs.Script().concierge(messages)

    graph = build_graph(
        stubs.models(stubs.Script(concierge=concierge)), stubs.toolbox(), memory_saver()
    )
    config = run_config("documents", "eval")
    await graph.ainvoke(stubs.first_input(), config)
    await graph.ainvoke(
        Command(
            resume=resume_with(
                {
                    "resume:summary": {"action": "edit", "text": "Reviewed Python summary."},
                }
            )
        ),
        config,
    )
    await graph.ainvoke({"messages": [HumanMessage("Why are keywords missing?")]}, config)
    assert len(seen) == 1
    assert "Reviewed Python summary." in seen[0]
    assert "current_keyword_coverage" in seen[0]
    assert '"missing": ["Kafka", "system design"]' in seen[0]


async def test_supported_keywords_get_a_bounded_rewrite_and_unsupported_terms_stay_gaps():
    attempts = []

    def gap(messages):
        return stubs.call(
            "Rubric",
            score=64,
            keyword_evidence={
                "system design": "Led migration of 12 services to Kubernetes",
                "Kafka": "A made-up quote that is not in the resume",
            },
        )

    def writer(messages):
        attempts.append(messages)
        if "still omits" in messages[-1].text:
            return stubs.call(
                "Drafts",
                proposals=[
                    {
                        "target": "summary",
                        "proposed": "Python engineer with system design experience "
                        "migrating services to Kubernetes.",
                        "rationale": "Expresses the documented architecture work.",
                        "keywords": ["system design"],
                    }
                ],
            )
        return stubs.call(
            "Drafts",
            proposals=[
                {
                    "target": "summary",
                    "proposed": "Python engineer building payment APIs.",
                    "rationale": "Focus",
                    "keywords": ["system design"],
                }
            ],
        )

    graph = build_graph(
        stubs.models(stubs.Script(gap=gap, resume_writer=writer)), stubs.toolbox(), memory_saver()
    )
    config = run_config("keywords", "eval")
    await graph.ainvoke(stubs.first_input(), config)
    paused = await graph.aget_state(config, subgraphs=True)
    analysis = paused.tasks[0].state.values
    assert analysis["keyword_evidence"] == {
        "system design": "Led migration of 12 services to Kubernetes"
    }
    assert len(attempts) == 2
    assert "system design" in analysis["proposals"]["resume:summary"].proposed
    assert "Kafka" not in analysis["proposals"]["resume:summary"].proposed
    assert any("Confirm experience before adding 'Kafka'" in p for p in analysis["gap"].priorities)
    decisions = {pid: {"action": "accept"} for pid in analysis["proposals"]}
    await graph.ainvoke(Command(resume=resume_with(decisions)), config)
    text = current_documents((await graph.aget_state(config)).values)
    body = json.loads(text.split(">", 1)[1].rsplit("</untrusted_content>", 1)[0])
    assert "system design" in body["current_keyword_coverage"]["matched"]
    assert body["current_keyword_coverage"]["missing"] == ["Kafka"]
