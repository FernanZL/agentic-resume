"""The API end to end on stub models: documents, a session through review and export,
the guards (passcode, budget, one run at a time) and resuming a cut-off run."""

import asyncio
import io
import threading

import docx
import httpx
import pytest
from openrouter.errors import NoResponseError, OpenRouterError

from agent.llm import NoStructuredAnswer
from agent.tests import stubs
from backend.budget import BudgetExceeded
from backend.errors import error_code
from backend.events import event_stream
from backend.runner import RunActive


async def paste(client, kind="resume", text=stubs.RESUME):
    response = await client.post("/api/documents/text", json={"kind": kind, "text": text})
    assert response.status_code == 201, response.text
    return response.json()["document_id"]


async def new_session(client, services, linkedin=True):
    body = {
        "resume_document_id": await paste(client),
        "linkedin_document_id": await paste(client, "linkedin", stubs.LINKEDIN * 3)
        if linkedin
        else "",
        "target": stubs.TARGET.model_dump(),
    }
    response = await client.post("/api/sessions", json=body)
    assert response.status_code == 202, response.text
    session_id = response.json()["session_id"]
    await services.runner.wait(session_id)
    return session_id


async def events_of(services, session_id):
    return await services.db.events_after(session_id, 0, 1000)


async def test_health(client):
    response = await client.get("/api/health")
    assert response.json() == {"status": "ok", "database": True}


async def test_followup_preserves_reviewed_snapshot_and_export(client, services):
    session_id = await new_session(client, services)
    path = f"/api/sessions/{session_id}"
    response = await client.post(
        path + "/review",
        json={
            "decisions": {
                "resume:summary": {"action": "edit", "text": "The summary I approved."},
            }
        },
    )
    assert response.status_code == 202
    await services.runner.wait(session_id)
    before = (await client.get(path)).json()
    before_export = (await client.get(path + "/export?format=json")).json()
    response = await client.post(
        path + "/messages",
        json={
            "content": "Why didn't you add the missing keywords?",
        },
    )
    assert response.status_code == 202
    await services.runner.wait(session_id)
    after = (await client.get(path)).json()
    for key in ("target", "reports", "gap", "proposals", "decisions", "reviewed"):
        assert after[key] == before[key], key
    assert after["status"] == "idle"
    assert (await client.get(path + "/export?format=json")).json() == before_export
    assert before_export["resume"]["summary"] == "The summary I approved."


async def test_posts_need_the_passcode(client):
    response = await client.post(
        "/api/documents/text",
        headers={"X-Demo-Passcode": "nope"},
        json={"kind": "resume", "text": stubs.RESUME},
    )
    assert response.status_code == 401
    assert response.json()["detail"] == "bad_passcode"


async def test_uploads_are_parsed_and_checked(client, services):
    document = docx.Document()
    document.add_paragraph(stubs.RESUME)
    buffer = io.BytesIO()
    document.save(buffer)
    files = {"file": ("cv.docx", buffer.getvalue())}
    response = await client.post("/api/documents", data={"kind": "resume"}, files=files)
    assert response.status_code == 201
    assert response.json()["preview"].startswith("Alex Rivera")

    bad = await client.post(
        "/api/documents", data={"kind": "resume"}, files={"file": ("cv.exe", b"x" * 100)}
    )
    assert bad.status_code == 415
    empty = await client.post(
        "/api/documents", data={"kind": "resume"}, files={"file": ("cv.txt", b"hi")}
    )
    assert empty.status_code == 422
    assert empty.json()["detail"] == "no_text_found"
    services.settings = services.settings.__class__(
        **{**services.settings.__dict__, "max_upload_bytes": 10}
    )
    big = await client.post(
        "/api/documents", data={"kind": "resume"}, files={"file": ("cv.txt", b"x" * 100)}
    )
    assert big.status_code == 413


async def test_a_session_runs_to_review_then_exports(client, services):
    session_id = await new_session(client, services)

    snapshot = (await client.get(f"/api/sessions/{session_id}")).json()
    assert snapshot["status"] == "review"
    assert set(snapshot["reports"]) == {"job", "market", "company", "linkedin"}
    assert {p["id"] for p in snapshot["proposals"]} == {
        "resume:summary",
        "resume:exp1.b0",
        "linkedin:headline",
    }
    assert snapshot["messages"][0]["role"] == "user"
    assert snapshot["cost_usd"] > 0
    types = [e["type"] for e in await events_of(services, session_id)]
    assert types[0] == "run_started"
    assert "review_required" in types
    assert "gap_ready" in types
    assert snapshot["last_event_id"] > 0

    blocked = await client.post(f"/api/sessions/{session_id}/messages", json={"content": "hi"})
    assert blocked.status_code == 409
    assert blocked.json()["detail"] == "review_pending"
    early = await client.get(f"/api/sessions/{session_id}/export?format=md")
    assert early.status_code == 409

    decisions = {
        "resume:summary": {"action": "accept", "text": ""},
        "linkedin:headline": {"action": "edit", "text": "Backend Engineer, Payments"},
    }
    response = await client.post(
        f"/api/sessions/{session_id}/review", json={"decisions": decisions}
    )
    assert response.status_code == 202
    await services.runner.wait(session_id)

    snapshot = (await client.get(f"/api/sessions/{session_id}")).json()
    assert snapshot["status"] == "idle"
    assert set(snapshot["decisions"]) == set(decisions)
    assert snapshot["messages"][-1]["role"] == "assistant"

    markdown = await client.get(f"/api/sessions/{session_id}/export?format=md")
    assert "high-volume payment APIs" in markdown.text
    assert "Backend Engineer, Payments" in markdown.text
    assert "Maintained checkout service" in markdown.text  # not accepted: unchanged
    word = await client.get(f"/api/sessions/{session_id}/export?format=docx")
    assert word.content[:2] == b"PK"
    assert "alex-rivera-staff-backend-engineer.docx" in word.headers["content-disposition"]


async def test_documents_belong_to_one_session(client, services):
    resume = await paste(client)
    body = {
        "resume_document_id": resume,
        "linkedin_document_id": "",
        "target": {"title": "Engineer"},
    }
    first = await client.post("/api/sessions", json=body)
    await services.runner.wait(first.json()["session_id"])
    again = await client.post("/api/sessions", json=body)
    assert again.status_code == 409
    assert again.json()["detail"] == "document_already_used"
    unknown = await client.post("/api/sessions", json={**body, "resume_document_id": "nope"})
    assert unknown.status_code == 404


async def test_one_run_at_a_time(services):
    gate = asyncio.Event()

    async def held(*_):
        await gate.wait()

    services.runner._execute = held  # a run that waits until released
    await services.db.add_session("s1", {"title": "x"}, False)
    await services.runner.start("s1", "message", {})
    with pytest.raises(RunActive):
        await services.runner.start("s1", "message", {})
    gate.set()


async def test_the_daily_budget_refuses_new_runs(client, services):
    await services.db.add_model_call("old", "r", "concierge", "m", 1, 1, 10.0)
    body = {
        "resume_document_id": await paste(client),
        "linkedin_document_id": "",
        "target": {"title": "Engineer"},
    }
    response = await client.post("/api/sessions", json=body)
    assert response.status_code == 429
    assert response.json()["detail"] == "budget_exceeded"


async def test_the_budget_stops_a_run_between_model_calls(client, services):
    services.budget.daily_limit = 0.005  # two stub calls cost 0.004, the third can't start
    services.budget.reservation = 0.0
    session_id = await new_session(client, services)
    events = await events_of(services, session_id)
    assert events[-1]["type"] == "run_failed"
    assert events[-1]["data"]["error"] == "budget_exceeded"
    snapshot = (await client.get(f"/api/sessions/{session_id}")).json()
    assert snapshot["status"] == "failed"
    with pytest.raises(BudgetExceeded):
        await services.budget.check()


async def test_a_cut_off_run_resumes_from_its_checkpoint(client, services, script):
    entered, release = threading.Event(), threading.Event()
    default_intake = script.intake

    def slow_intake(messages):
        entered.set()
        release.wait(5)
        return default_intake(messages)

    script.overrides["intake"] = slow_intake
    body = {
        "resume_document_id": await paste(client),
        "linkedin_document_id": "",
        "target": stubs.TARGET.model_dump(),
    }
    session_id = (await client.post("/api/sessions", json=body)).json()["session_id"]
    await asyncio.to_thread(entered.wait, 5)
    await services.runner.shutdown()  # the process stops mid-run
    release.set()
    assert (await client.get(f"/api/sessions/{session_id}")).json()["status"] == "interrupted"

    script.overrides.pop("intake")
    response = await client.post(f"/api/sessions/{session_id}/resume")
    assert response.status_code == 202
    await services.runner.wait(session_id)
    snapshot = (await client.get(f"/api/sessions/{session_id}")).json()
    assert snapshot["status"] == "review"
    concierge_calls = [m for m in snapshot["messages"] if m["role"] == "assistant"]
    assert concierge_calls == []  # it picked up inside the analysis, not from the start


async def test_stale_runs_become_interrupted_at_startup(services):
    await services.db.add_session("s1", {"title": "x"}, False)
    await services.db.add_run("r1", "s1", "message")
    await services.db.set_status("s1", "running")
    assert await services.db.interrupt_stale_runs() == 1
    assert (await services.db.get_session("s1"))["status"] == "interrupted"


async def test_the_event_stream_replays_after_a_cursor_and_wakes_on_new_events(services):
    bus = services.bus
    await services.db.add_session("s1", {"title": "x"}, False)
    first = await bus.record("s1", "r1", "node_started", "intake", {"label": "Reading"})
    await bus.record("s1", "r1", "node_finished", "intake", {"label": "Reading", "seconds": 1})

    received: list[str] = []

    async def gone():
        return len(received) >= 4

    async def consume():
        async for chunk in event_stream(bus, "s1", first, gone, keep_alive=0.05):
            received.append(chunk)

    task = asyncio.create_task(consume())
    await asyncio.sleep(0.02)
    await bus.record("s1", "r1", "message", "concierge", {"content": "Hi"})
    await asyncio.wait_for(task, 2)
    assert received[0].startswith("retry:")
    assert "event: node_finished" in received[1]  # the first event is before the cursor
    assert any("event: message" in chunk for chunk in received)
    assert not any("node_started" in chunk for chunk in received)


async def test_get_unknown_session_is_404(client):
    assert (await client.get("/api/sessions/nope")).status_code == 404
    assert (await client.get("/api/sessions/nope/events")).status_code == 404


async def test_a_failing_run_is_reported(client, services, script):
    await services.db.add_session("s1", {"title": "x"}, False)
    script.overrides["concierge"] = lambda messages: (_ for _ in ()).throw(ValueError("boom"))
    await services.runner.start("s1", "message", stubs.first_input())
    await services.runner.wait("s1")
    events = await events_of(services, "s1")
    assert events[-1]["type"] == "run_failed"
    assert events[-1]["data"]["error"] == "internal_error"  # a code, never the message
    assert not any("boom" in str(e["data"]) for e in events)


async def test_two_requests_cant_both_start_a_run(services):
    await services.db.add_session("s1", {"title": "x"}, False)
    payload = {**stubs.first_input(), "messages": []}
    results = await asyncio.gather(
        services.runner.start("s1", "message", payload),
        services.runner.start("s1", "message", payload),
        return_exceptions=True,
    )
    assert sum(isinstance(r, RunActive) for r in results) == 1
    await services.runner.wait("s1")


async def test_each_call_reserves_budget_until_its_cost_is_recorded(services):
    budget = services.budget
    budget.daily_limit, budget.reservation = 0.015, 0.01
    await budget.reserve()  # 0.01 held
    with pytest.raises(BudgetExceeded):
        await budget.reserve()  # 0.02 would exceed 0.015
    assert budget.in_flight == 1
    budget.release()
    await budget.check()


async def test_a_failed_session_creation_claims_nothing(client):
    resume = await paste(client)
    body = {
        "resume_document_id": resume,
        "linkedin_document_id": "missing",
        "target": {"title": "Engineer"},
    }
    failed = await client.post("/api/sessions", json=body)
    assert failed.status_code == 404
    retried = await client.post("/api/sessions", json={**body, "linkedin_document_id": ""})
    assert retried.status_code == 202  # the resume was not stranded


async def test_events_carry_no_document_text(client, services):
    session_id = await new_session(client, services)
    events = await events_of(services, session_id)
    text = " ".join(str(e["data"]) for e in events if e["type"] not in {"token", "message"})
    assert "payment" not in text.lower()
    assert "checkout" not in text.lower()
    ready = [e for e in events if e["type"] == "proposals_ready"]
    assert ready
    assert all(set(e["data"]) == {"round", "proposal_ids"} for e in ready)


async def test_reviewed_documents_export_as_print_html_and_json(client, services, script):
    script.overrides["resume_writer"] = lambda messages: stubs.call(
        "Drafts",
        proposals=[
            {
                "target": "summary",
                "proposed": "<script>alert(1)</script> Payments engineer",
                "rationale": "x",
            }
        ],
    )
    session_id = await new_session(client, services, linkedin=False)
    assert (await client.get(f"/api/sessions/{session_id}")).json()["reviewed"] is False
    accept = {"resume:summary": {"action": "accept", "text": ""}}
    await client.post(f"/api/sessions/{session_id}/review", json={"decisions": accept})
    await services.runner.wait(session_id)
    assert (await client.get(f"/api/sessions/{session_id}")).json()["reviewed"] is True

    page = await client.get(f"/api/sessions/{session_id}/export?format=html")
    assert page.headers["content-security-policy"].startswith("default-src 'none'")
    assert "<script>" not in page.text
    assert "&lt;script&gt;" in page.text
    final = (await client.get(f"/api/sessions/{session_id}/export?format=json")).json()
    assert final["resume"]["summary"].endswith("Payments engineer")
    assert final["resume"]["name"] == "Alex Rivera"


def test_failures_are_reported_as_codes():
    response = httpx.Response(429, request=httpx.Request("POST", "https://openrouter.ai"))
    assert error_code(OpenRouterError("slow down", response)) == "model_error"
    assert error_code(NoResponseError()) == "model_error"
    assert error_code(BudgetExceeded("spent")) == "budget_exceeded"
    assert error_code(NoStructuredAnswer("prose")) == "invalid_model_output"
    assert error_code(KeyError("x")) == "internal_error"
