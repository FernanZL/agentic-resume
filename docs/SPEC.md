# SPEC: Agentic Resume (approved design, 2026-11-07)

## Context

Portfolio project that both **demonstrates** multi-agent engineering skills and is **useful** to its author: a chat-first app that takes a resume (+ optional LinkedIn export) and a target position, fans out research subagents (job, company, market, LinkedIn), runs an ATS gap analysis, writes grounded rewrites, has them fact-checked by a critic, and lets the user accept/reject them before exporting. Reuses the patterns of `~/projects/undercover` (finished code on branch `origin/week3day5-end`): hand-built LangGraph `StateGraph`, `Send` fan-out, `interrupt()`/`Command(resume=)`, Postgres checkpointer, FastAPI + React/Vite SPA, docs-driven process (`AGENTS.md`, `docs/SPEC|TECH_STACK|CODE_STANDARDS|PROCESS|STATUS.md`). Local first with Docker Compose, then Render. **Design only** — a phased implementation plan follows once aligned.

Design reviewed in two rounds with **argon** (Antigravity agent in Herdr pane `w8:p3`); its corrections are folded in.

**Decisions taken (user):**
- **LLM**: OpenRouter via `langchain-openrouter` (`ChatOpenRouter`: cost from OpenRouter's `usage.cost`, reasoning kept, model per node configurable by env).
- **Demo access**: shared `DEMO_PASSCODE` header gate + `MAX_DAILY_COST_USD` breaker; no user accounts.
- **Web search**: Tavily (`langchain-tavily`); `fetch_url` = httpx + trafilatura.
- **Frontend**: full React/Vite SPA in v1 (chat, live SSE timeline, diff review).

## 1. Agent topology — one top-level graph per session

```
START ─► concierge ⇄ tools ──(route=analyze)──► analysis [subgraph node] ─► concierge ─► END (wait for next message)
```

**Concierge (chat)** — bounded ReAct node (model-call limit per turn, like undercover's Copilot). It greets, asks clarifying questions in chat (missing JD, seniority, region), and when inputs are sufficient calls `request_analysis(target)`. State-changing tools (`request_analysis`, `revise_proposal`) take `InjectedToolCallId` and return `Command(update={"route": "analyze", "target": …, "messages": [ToolMessage(…)]})`; the conditional edge after `tools` goes **straight to `analysis`** when `route == "analyze"` (no extra LLM call), and `intake` resets `route=None` so `analysis → concierge` never loops. After analysis the concierge explains results and handles follow-ups via read tools (`get_report`, `explain_proposal`) and `revise_proposal(id, instruction)`, which rewrites one proposal, runs the critic checks inline, and returns `Command(update={"proposals": {id: new}})`.
*Why:* the analysis graph is added with `add_node("analysis", analysis_graph)`, a native subgraph compiled **without** its own checkpointer argument (default → inherits the parent's; `checkpointer=False` would disable the persistence `interrupt` needs). Its `interrupt()` then propagates correctly and chat history stays valid (invoking a graph inside a tool would orphan tool calls on interrupt).
**While a review is pending**, `POST /messages` still returns `409 review_pending` to protect the interrupted thread. The UI uses a separate budgeted `/ask` path for persisted questions and checked suggestions; that path never resumes or updates the analysis checkpoint. Suggestions can be loaded into browser edit drafts and applied explicitly through `/review`. Finished documents can be explicitly amended through `/amend`, with a content revision guard. A fresh analysis is a separate confirmed `/reanalyze` action, not a model-selected consequence of a question.

**Analysis subgraph — deterministic map-reduce, no LLM supervisor** (routing is code; LLMs work inside nodes):

```
intake ─► plan ─Send×N─► [researchers] ─► gap_analysis ─► writers(resume ∥ linkedin) ─► critic ⇄ (≤2) ─► review ⏸ ─► finalize
```

| Node | Kind | Output (Pydantic) | Tools |
|---|---|---|---|
| `intake` | code + 1 structured call | `CandidateProfile` (sections, bullets, skills, dates), `TargetJob`, plus `is_safe` / `injection_reason` (prompt-injection screening folded in, saving one call). On re-analysis it clears old results with `Overwrite({})` on `reports` and `proposals` (undercover uses `Overwrite`) and resets `route` | pymupdf4llm / python-docx |
| `plan` | code | `Send` list — skips company research if no company, LinkedIn audit if no export | — |
| `job_analyst` | bounded ReAct (≤4 tool calls), **private** message list inside the node; only the final report is written to `reports[kind]` (applies to all researchers) | `JobAnalysis`: must/nice-to-have skills, seniority, keywords | `fetch_url`, `web_search` |
| `company_researcher` | bounded ReAct | `CompanyBrief`: product, stack, values, tone, news (+ source URLs) | `web_search`, `fetch_url` |
| `market_analyst` | bounded ReAct | `MarketBrief`: title variants, adjacent in-demand skills, level signals | `web_search` |
| `linkedin_auditor` | structured call, optional exact public profile retrieval | `LinkedInAudit`: headline/About/experience gaps | Tavily advanced profile search when a URL is supplied instead of an export |
| `gap_analysis` | **code first** (keyword coverage, ATS format checks) + LLM rubric | `GapReport`: score 0–100, missing keywords, weak bullets, priorities | — |
| `resume_writer` ∥ `linkedin_writer` | one structured call each over the **whole** document (coherent voice, no duplicated keywords) | `Proposal`s keyed by `proposal_id` (original, proposed, rationale, keywords, evidence refs) | — |
| `critic` | code evidence check + LLM judge | flags invented numbers/claims, keyword stuffing, tone → loops back to writers (max 2) | — |
| `review` | `interrupt(proposals)` | accept / reject / edit per proposal | — |
| `finalize` | code | applies decisions → `final_profile` + LinkedIn copy blocks **in state only**; files are rendered on demand by the export endpoint, so later `revise_proposal` edits are always reflected | — |

Rules enforced in code (undercover standard: "anything that must always happen is code"): writers may only use facts present in `CandidateProfile`; unknown metrics become `[X]%` placeholders flagged in the UI; nothing exports without the review step. Fetched web text is untrusted: `fetch_url` strips it, wraps it in XML delimiters and sanitizes it (regex) before analysts see it.

LangGraph features showcased: native subgraph, conditional routing, `Send` fan-out + `max_concurrency`, `RetryPolicy` (rate-limit/timeout), `interrupt`/`Command(resume)`, `context_schema` for ids (model never supplies ids), structured output, middleware for call limits + cost recording, evaluator-optimizer loop (critic).

## 2. State (checkpoint is the single source of truth for agent output)

```python
class AnalysisState(TypedDict):
    profile: CandidateProfile
    target: TargetJob
    linkedin: LinkedInProfile | None
    reports: Annotated[dict[str, Report], merge_dict]        # one key per researcher → no Send collisions
    gap: GapReport | None
    proposals: Annotated[dict[str, Proposal | None], merge_dict]  # keyed by proposal_id → retries overwrite; value None = delete (reducer drops it)
    critique_rounds: int
    decisions: dict[str, Decision] | None

    final_profile: CandidateProfile | None

class SessionState(AnalysisState):          # subclass → shared keys can never drift from the subgraph's
    messages: Annotated[list[AnyMessage], add_messages]
    model_calls: Annotated[int, operator.add]
    route: str | None
```
`GET /api/sessions/{id}` uses `graph.aget_state(config, subgraphs=True)` to surface a pending review interrupt from inside the subgraph.
Run context (`session_id`, `run_id`) via `context_schema` dataclass (undercover `ClaimContext`). Reports/proposals are read from the checkpoint (`graph.aget_state`) — no duplicate SQL tables.

## 3. API (FastAPI, `/api`)

| Method & path | Purpose |
|---|---|
| `GET /api/health` | Render health check |
| `POST /api/documents` (multipart, ≤2 MB) | upload resume / LinkedIn PDF-DOCX → `document_id` + parsed text (parsed in memory, raw file discarded) |
| `POST /api/sessions` | `{resume_document_id, linkedin_document_id?, target{title, company?, job_url?, job_text?}}` → `session_id` (= `thread_id`); starts the first concierge turn |
| `GET /api/sessions/{id}` | snapshot from checkpoint: messages, reports, proposals, status, pending review |
| `POST /api/sessions/{id}/messages` | chat turn → `202 {run_id}`, graph runs as background task (409 if a run is active) |
| `GET /api/sessions/{id}/events` | **SSE** stream |
| `POST /api/sessions/{id}/review` | `{decisions: {proposal_id: {action, text}}}` → `Command(resume=…)` |
| `POST /api/sessions/{id}/resume` | continue a run interrupted by restart/sleep from its checkpoint |
| `GET /api/sessions/{id}/export?format=docx\|md` | final artifacts (PDF via print-CSS view in the SPA — no Chromium/weasyprint in the image) |

**SSE design** (improvement over undercover's 2 s polling; the live subagent timeline is a showcase item): every event is written to `run_events (id BIGSERIAL)`; a per-session `asyncio.Event` is set on insert; the SSE handler loops `SELECT … WHERE session_id=:s AND id>:cursor` and waits on the event (with a keep-alive timeout). Reconnect uses `Last-Event-ID` as the cursor → no replay race. Event types: `token`, `node_started`, `tool_called`, `report_ready`, `proposal_ready`, `review_required`, `run_completed`, `error`. Produced from `graph.astream(stream_mode=["updates","messages","custom"], subgraphs=True)`.

API conventions from undercover `api_rules.py`: `operation_id` + one-line docstring on every operation, Pydantic request/response models.

## 4. Persistence

- **Postgres 16**, SQLAlchemy Core: `sessions`, `documents` (extracted text + JSON), `runs` (status, started/finished), `run_events`, `model_calls` (tokens, cost, node). SQLite for unit tests (undercover `conftest.py`).
- **Checkpointer**: `AsyncPostgresSaver` on `AsyncConnectionPool(max_size=4, kwargs={"prepare_threshold": None})` in its own schema (async, unlike undercover's sync saver, so the event loop/SSE never block). On startup (lifespan) stale `running` runs are marked `interrupted` → UI offers one-click resume.
- **Files**: none stored; exports generated on demand.

## 5. Repo layout & deployment

```
backend/   main.py, routers/{documents,sessions,events,exports}.py, database.py, events.py, budget.py, settings.py
agent/     graph.py (session graph), analysis.py (subgraph), nodes/, tools/{web_search,fetch_url,ats}.py,
           schemas.py, llm.py, checkpoints.py, prompts/*.md
web/       React + Vite + TS: chat panel · live agent timeline · proposal diff review · export/print view
evals/     golden cases (Langfuse dataset); code quality gates + faithfulness/tailoring judges on another model family; 3 repeats (see docs/portfolio/evals/)
docs/      SPEC, TECH_STACK, CODE_STANDARDS, PROCESS, STATUS  (+ AGENTS.md / CLAUDE.md)
Dockerfile (multi-stage: node build → python/uv slim), docker-compose.yml, render.yaml
```

- **Local**: `docker compose up` → `db` (postgres:16-alpine), `api` (uvicorn `--reload`, :8000, source mounted), `web` (Vite dev :5173, proxies `/api`).
- **Render**: **one** Docker web service (FastAPI serves `/api` + built SPA; graphs run in-process; `--workers 1`) + Postgres (Supabase free — Render free PG expires after 30 days, as in undercover). Declared in `render.yaml` Blueprint (undercover set Render up by hand). `agent/` stays an importable package so it can be split into its own service later.
- **Privacy**: the session UUID works like a password, so it's treated as one. Documents can only be read through the session that owns them (no access by bare `document_id`). Raw resume text and PII never go into logs. `run_events` carry ids and codes for reports, proposals and failures (the content is read from the checkpoint through the snapshot); only the chat streams its text. Exception messages are not logged unless `LOG_ERROR_DETAILS` is set.
- **Cost guard**: `budget.py` checks `sum(cost)` of `model_calls` over 24 h against `MAX_DAILY_COST_USD` before a run starts **and** before every model call (cost middleware, `before_model`), with a per-run cost reservation so parallel fan-out branches can't overspend together; per-session model-call caps; `X-Demo-Passcode` checked (`secrets.compare_digest`) on all **mutating** (POST) routes only. GETs, including SSE, are reached by the unguessable session UUID, because the browser's `EventSource` cannot send custom headers.
- **Observability**: one Langfuse trace per run (`backend/tracing.py`: session id as trace session, step-named generations with reasoning, contact details masked), cost per call in `model_calls`.
- **Config**: env vars read in one module (`settings.py`); `.env` locally.

## 6. Risks

1. **LinkedIn**: input = "Save to PDF" export, pasted text, or a supplied exact public profile URL. For URLs, Tavily advanced search with raw content retrieves only matching profile results; missing content falls back to an export or pasted text. No login or identity guessing. Direct auth-walled job URLs → concierge asks for pasted JD. This supersedes the original export-only restriction.
2. **Fabrication**: evidence check in code + critic loop + placeholders + mandatory review.
3. **Prompt injection** via resume/JD/web pages: screening fields in `intake` + sanitizing/delimiting in `fetch_url`.
4. **Public demo cost**: daily budget breaker + access gate.
5. **Render free tier** (512 MB, sleeps after 15 min): 1 worker, upload cap, no Chromium; checkpoint resume after sleep.

## 7. Build workflow (for the implementation plan)

Multi-agent development, mirroring undercover's `docs/PROCESS.md`: plan phases in `docs/PLAN_*.md`, then for each phase implement → checks → **independent code review** → update `STATUS.md` → commit.

- **Claude (lead)**: owns the contracts (`agent/schemas.py`, OpenAPI request/response models, SSE event types), `agent/graph.py` + `agent/analysis.py`, `backend/`, Docker/Render, and integrates everything.
- **argon (Antigravity, via Herdr)**: two delegated tracks with clear file boundaries, started once the contracts are frozen:
  1. `web/`: the React SPA, built with the **impeccable** design skill (split-pane chat, live subagent timeline cards, side-by-side diff review with placeholder highlighting, print view for PDF), against the frozen OpenAPI and SSE contract.
  2. `agent/tools/` (`ats.py` deterministic gap scoring, `fetch_url`, `web_search`) + `evals/`, with stub-model tests.
- **sol (Codex, GPT-6.1-Sol, Herdr pane `w8:p7`)**: code reviewer. Reviews every phase's changes against `docs/CODE_STANDARDS.md` before commit, read-only; findings are tagged MUST/SHOULD. Connection tested: sol is reachable and can read files outside the repo. Its replies are read with `herdr agent read sol --source detection` because Codex keeps its view scrolled.
- Agents never edit outside their assigned paths; contract changes go through the lead.

## Verification (detailed in the implementation plan)

- Unit tests with stub chat model + `InMemorySaver` (undercover `agent/tests/stubs.py`); never real models in tests.
- Graph tests: fan-out yields all reports; critic loop caps at 2; interrupt inside the subgraph fires and resumes through the parent; `request_analysis` routes once (no loop); re-analysis clears stale proposals; `revise_proposal` after finalize is reflected in export; proposals don't duplicate.
- API tests (TestClient): SSE replay from `Last-Event-ID`, 409 on concurrent run, budget breaker (including parallel branches), document access only through the owning session.
- Integration tests against **real Postgres** (compose `db` service): checkpoint resume after a restart, run lock, SSE wake-up and event ordering. SQLite only for fast unit tests.
- E2E: `docker compose up` → upload sample resume + JD → live timeline → accept proposals → download DOCX.
- Evals on golden set: coverage improves, fabrication flags = 0.
