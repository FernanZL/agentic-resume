"""Questions and staged edits remain separate from the review interrupt and accepted export."""

import asyncio
import copy

from agent.tests import stubs
from backend.database import Database
from backend.schemas import AskResponse, ChatMessage
from backend.tests.test_api import new_session


async def test_review_question_persists_history_without_touching_the_checkpoint(client, services):
    session_id = await new_session(client, services)
    path = f"/api/sessions/{session_id}"
    saver = services.runner.graph.checkpointer
    storage = copy.deepcopy(saver.storage)
    before = await services.runner.graph.aget_state(
        {"configurable": {"thread_id": session_id}}, subgraphs=True
    )
    events = await services.db.last_event_id(session_id)
    response = await client.post(
        path + "/ask", json={"content": "Why did you suggest this summary?"}
    )
    assert response.status_code == 200, response.text
    assert response.json()["suggestion"] is None
    assert saver.storage == storage
    assert await services.db.last_event_id(session_id) == events
    after = await services.runner.graph.aget_state(
        {"configurable": {"thread_id": session_id}}, subgraphs=True
    )
    assert after.next == before.next
    assert after.interrupts == before.interrupts
    snapshot = (await client.get(path)).json()
    assert snapshot["status"] == "review"
    assert any(m["content"] == "Why did you suggest this summary?" for m in snapshot["messages"])
    reopened_db = Database(services.db.engine)
    assert len(await reopened_db.advisory_history(session_id)) == 2
    await client.post(path + "/review", json={"decisions": {}})
    await services.runner.wait(session_id)
    assert (await client.get(path)).json()["reviewed"]


async def test_generated_revision_is_checked_but_not_accepted(client, services, script):
    session_id = await new_session(client, services)
    path = f"/api/sessions/{session_id}"
    before = (await client.get(path)).json()
    script.overrides["advisory"] = lambda messages: stubs.call(
        "AdvisoryAnswer",
        answer="Here is a draft; confirm the missing metric.",
        proposal_id="linkedin:headline",
        proposed_text="Backend Engineer | 99% uptime",
    )
    response = await client.post(path + "/ask", json={"content": "Shorten the headline"})
    assert response.status_code == 200, response.text
    suggestion = response.json()["suggestion"]
    assert suggestion["text"] == "Backend Engineer | [X] uptime"
    assert suggestion["issues"]
    after = (await client.get(path)).json()
    assert after["proposals"] == before["proposals"]
    assert after["decisions"] == before["decisions"]
    assert (await client.get(path + "/export?format=json")).status_code == 409
    response = await client.post(
        path + "/review",
        json={
            "decisions": {
                suggestion["proposal_id"]: {"action": "edit", "text": suggestion["text"]},
            }
        },
    )
    assert response.status_code == 202
    await services.runner.wait(session_id)
    assert (await client.get(path + "/export?format=json")).json()["linkedin"][
        "headline"
    ] == suggestion["text"]


async def test_new_valid_target_can_be_staged_and_explicitly_reviewed(client, services, script):
    session_id = await new_session(client, services)
    path = f"/api/sessions/{session_id}"
    script.overrides["advisory"] = lambda messages: stubs.call(
        "AdvisoryAnswer",
        answer="Review this headline before applying it.",
        target="headline",
        document="resume",
        proposed_text="Backend Engineer · Payments",
    )
    response = await client.post(path + "/ask", json={"content": "Add a resume headline"})
    assert response.status_code == 200, response.text
    suggestion = response.json()["suggestion"]
    addition = suggestion["proposal"]
    assert addition["id"] == "resume:headline"
    assert not any(p["id"] == addition["id"] for p in (await client.get(path)).json()["proposals"])
    response = await client.post(
        path + "/review",
        json={
            "decisions": {addition["id"]: {"action": "edit", "text": suggestion["text"]}},
            "additions": [addition],
        },
    )
    assert response.status_code == 202, response.text
    await services.runner.wait(session_id)
    exported = (await client.get(path + "/export?format=json")).json()
    assert exported["resume"]["headline"] == "Backend Engineer · Payments"


async def test_postreview_amendment_requires_an_explicit_decision(client, services):
    session_id = await new_session(client, services)
    path = f"/api/sessions/{session_id}"
    response = await client.post(path + "/amend", json={"decisions": {}})
    assert response.status_code == 409
    await client.post(
        path + "/review",
        json={
            "decisions": {
                "resume:summary": {"action": "accept"},
                "linkedin:headline": {"action": "reject"},
            }
        },
    )
    await services.runner.wait(session_id)
    before = (await client.get(path + "/export?format=json")).json()
    await client.post(path + "/ask", json={"content": "Explain the headline"})
    assert (await client.get(path + "/export?format=json")).json() == before
    response = await client.post(
        path + "/amend",
        json={
            "expected_revision": (await client.get(path)).json()["revision"],
            "decisions": {
                "resume:summary": {"action": "edit", "text": "My explicitly approved summary."},
            },
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["decisions"]["linkedin:headline"]["action"] == "reject"
    assert (await client.get(path + "/export?format=json")).json()["resume"][
        "summary"
    ] == "My explicitly approved summary."


async def test_ask_and_review_are_serialized_and_budgeted(client, services, script):
    session_id = await new_session(client, services)
    path = f"/api/sessions/{session_id}"
    services.runner.claimed.add(session_id)
    try:
        assert (await client.post(path + "/ask", json={"content": "Why?"})).status_code == 409
    finally:
        services.runner.claimed.discard(session_id)
    services.budget.daily_limit = 0.001
    assert (await client.post(path + "/ask", json={"content": "Why?"})).status_code == 429
    assert not services.runner.active(session_id)
    assert (await client.get(path)).json()["status"] == "review"


async def test_rerun_requires_confirmation_and_keeps_the_exact_requested_target(client, services):
    session_id = await new_session(client, services)
    path = f"/api/sessions/{session_id}"
    await client.post(path + "/review", json={"decisions": {}})
    await services.runner.wait(session_id)
    target = {"title": "Platform Engineer", "company": "", "job_text": "Kubernetes and Python"}
    response = await client.post(path + "/reanalyze", json={"target": target})
    assert response.status_code == 422
    assert (await client.get(path)).json()["target"]["title"] == stubs.TARGET.title
    response = await client.post(path + "/reanalyze", json={"target": target, "confirmed": True})
    assert response.status_code == 202, response.text
    await services.runner.wait(session_id)
    snapshot = (await client.get(path)).json()
    assert snapshot["target"]["title"] == "Platform Engineer"
    assert snapshot["target"]["company"] == ""
    assert (await services.db.get_session(session_id))["target"] == snapshot["target"]
    assert snapshot["status"] == "review"


async def test_invalid_scope_or_model_error_never_mutates_pending_review(client, services, script):
    session_id = await new_session(client, services)
    path = f"/api/sessions/{session_id}"
    response = await client.post(
        path + "/ask", json={"content": "Change it", "proposal_id": "resume:exp999.b0"}
    )
    assert response.status_code == 422
    script.overrides["advisory"] = lambda messages: stubs.AIMessage("Not structured")
    response = await client.post(path + "/ask", json={"content": "Why?"})
    assert response.status_code == 502
    assert response.json()["detail"] == "invalid_model_output"
    assert not services.runner.active(session_id)
    assert (await client.get(path)).json()["status"] == "review"


async def test_review_cannot_resume_while_an_advisory_answer_is_in_flight(
    client, services, monkeypatch
):
    session_id = await new_session(client, services)
    path = f"/api/sessions/{session_id}"
    started, release = asyncio.Event(), asyncio.Event()

    async def held(*args):
        started.set()
        await release.wait()
        return AskResponse(message=ChatMessage(id="held", role="assistant", content="Answer."))

    monkeypatch.setattr("backend.routers.sessions.answer_question", held)
    task = asyncio.create_task(client.post(path + "/ask", json={"content": "Explain this"}))
    await asyncio.wait_for(started.wait(), timeout=2)
    try:
        response = await client.post(path + "/review", json={"decisions": {}})
        assert response.status_code == 409
        assert response.json()["detail"] == "run_active"
    finally:
        release.set()
    assert (await task).status_code == 200
    assert (await client.get(path)).json()["status"] == "review"


async def test_stale_review_cannot_overwrite_a_newer_approved_edit(client, services):
    session_id = await new_session(client, services)
    path = f"/api/sessions/{session_id}"
    await client.post(path + "/review", json={"decisions": {}})
    await services.runner.wait(session_id)
    revision = (await client.get(path)).json()["revision"]
    first = await client.post(
        path + "/amend",
        json={
            "expected_revision": revision,
            "decisions": {
                "resume:summary": {"action": "edit", "text": "The latest approved summary."}
            },
        },
    )
    assert first.status_code == 200, first.text
    stale = await client.post(
        path + "/amend",
        json={
            "expected_revision": revision,
            "decisions": {"resume:summary": {"action": "edit", "text": "An older tab's text."}},
        },
    )
    assert stale.status_code == 409
    assert stale.json()["detail"] == "stale_review"
    final = (await client.get(path + "/export?format=json")).json()
    assert final["resume"]["summary"] == "The latest approved summary."


async def test_failed_confirmed_rerun_cannot_restart_on_an_ordinary_message(
    client, services, script
):
    session_id = await new_session(client, services)
    path = f"/api/sessions/{session_id}"
    await client.post(path + "/review", json={"decisions": {}})
    await services.runner.wait(session_id)
    await client.post(
        path + "/reanalyze", json={"target": {"title": "Platform Engineer"}, "confirmed": True}
    )
    await services.runner.wait(session_id)

    def fail_after_review(messages):
        raise RuntimeError("Simulated model failure")

    script.overrides["concierge"] = fail_after_review
    await client.post(
        path + "/review", json={"decisions": {"resume:summary": {"action": "accept"}}}
    )
    await services.runner.wait(session_id)
    assert (await client.get(path)).json()["status"] == "failed"
    rounds = script.critic_rounds
    script.overrides.pop("concierge")
    await client.post(path + "/messages", json={"content": "Thanks, explain the result."})
    await services.runner.wait(session_id)
    assert script.critic_rounds == rounds
    assert (await client.get(path)).json()["status"] == "idle"
    exported = (await client.get(path + "/export?format=json")).json()
    assert "high-volume payment APIs" in exported["resume"]["summary"]


async def test_failed_analysis_cannot_restart_from_a_plain_followup(client, services, script):
    session_id = await new_session(client, services)
    path = f"/api/sessions/{session_id}"
    await client.post(path + "/review", json={"decisions": {}})
    await services.runner.wait(session_id)

    def fail_writer(messages):
        raise RuntimeError("Simulated writer failure")

    script.overrides["resume_writer"] = fail_writer
    await client.post(
        path + "/reanalyze", json={"target": {"title": "Platform Engineer"}, "confirmed": True}
    )
    await services.runner.wait(session_id)
    assert (await client.get(path)).json()["status"] == "failed"
    events = await services.db.events_after(session_id, 0, 2000)
    intake_count = sum(e["type"] == "node_started" and e["node"] == "intake" for e in events)
    script.overrides.pop("resume_writer")
    await client.post(path + "/messages", json={"content": "Explain what happened, please."})
    await services.runner.wait(session_id)
    later = await services.db.events_after(session_id, 0, 2000)
    assert sum(e["type"] == "node_started" and e["node"] == "intake" for e in later) == intake_count
    assert (await client.get(path)).json()["reviewed"] is False


async def test_mismatched_focus_does_not_offer_wrong_field_text(client, services, script):
    session_id = await new_session(client, services)
    path = f"/api/sessions/{session_id}"
    script.overrides["advisory"] = lambda messages: stubs.call(
        "AdvisoryAnswer",
        answer="The headline belongs in LinkedIn Intro.",
        proposal_id="linkedin:headline",
        proposed_text="Backend Engineer",
    )
    response = await client.post(
        path + "/ask", json={"content": "Explain the headline", "proposal_id": "resume:summary"}
    )
    assert response.status_code == 200
    assert response.json()["suggestion"] is None


async def test_critic_failure_preserves_answer_and_marks_draft_unchecked(client, services, script):
    session_id = await new_session(client, services)
    path = f"/api/sessions/{session_id}"
    script.overrides["advisory"] = lambda messages: stubs.call(
        "AdvisoryAnswer",
        answer="Here is wording to review.",
        proposal_id="resume:summary",
        proposed_text="Backend engineer building payments APIs.",
    )
    script.overrides["critic"] = lambda messages: stubs.AIMessage("Malformed critic output")
    response = await client.post(path + "/ask", json={"content": "Reword the summary"})
    assert response.status_code == 200, response.text
    assert response.json()["message"]["content"] == "Here is wording to review."
    assert response.json()["suggestion"]["issues"]
    assert (await client.get(path)).json()["decisions"] == {}


async def test_advisory_turns_replay_to_legacy_chat_once_and_scope_after_rerun(
    client, services, script
):
    session_id = await new_session(client, services)
    path = f"/api/sessions/{session_id}"
    await client.post(path + "/review", json={"decisions": {}})
    await services.runner.wait(session_id)
    await client.post(path + "/ask", json={"content": "Explain my previous analysis score."})
    seen = []

    def concierge(messages):
        seen.append(" ".join(m.text for m in messages))
        return stubs.Script().concierge(messages)

    script.overrides["concierge"] = concierge
    await client.post(path + "/messages", json={"content": "What did we discuss?"})
    await services.runner.wait(session_id)
    assert any("previous analysis score" in prompt for prompt in seen)
    snapshot = (await client.get(path)).json()
    assert (
        sum(m["content"] == "Explain my previous analysis score." for m in snapshot["messages"])
        == 1
    )
    await client.post(
        path + "/reanalyze", json={"confirmed": True, "target": {"title": "Other Engineer"}}
    )
    await services.runner.wait(session_id)
    contexts = []

    def advisory(messages):
        contexts.append(messages[1].text)
        return stubs.call("AdvisoryAnswer", answer="These are the new results.")

    script.overrides["advisory"] = advisory
    await client.post(path + "/ask", json={"content": "Explain the new results"})
    assert "previous analysis score" not in contexts[0]
