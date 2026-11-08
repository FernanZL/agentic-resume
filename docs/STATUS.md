# Status

| Phase | Owner | State |
|---|---|---|
| 0. Scaffold + contract | Claude | done |
| 1. Agent tools (`agent/tools/`) | argon | done, reviewed twice by sol (SSRF, DNS-rebinding pinning, size cap) |
| 2. Graphs (concierge + analysis subgraph) | Claude | done, reviewed by sol, fixes applied |
| 3. Backend (API, SSE, budget, persistence, exports) | Claude | done, reviewed by sol, fixes applied |
| 4. Web SPA (`web/`) | argon, then a redesign by Claude | Rebuilt through the impeccable process: user-chosen direction "The Score", finish review disposition ship, documented in DESIGN.md |
| 5. Docker, Render Blueprint, evals | Claude | done (evals moved from argon to Claude) |
| 6a. Connect real keys, run locally (Docker + Postgres), Langfuse tracing | user + Claude | done: real sessions end to end, traces audited, reviewed twice by sol (verdict ship) |
| 6b. Evals baseline, deploy to Render + Supabase | user + Claude | **next** |

## Local run (verified 2026-11-07)
- Keys in `.env`: OpenRouter, Tavily, Langfuse (US region, `LANGFUSE_BASE_URL`). `openai/gpt-6-luna` exists on OpenRouter and supports tools ($0.10/M in, $0.50/M out); a full session (research, gap, 1–3 writer/critic rounds, review) costs about $0.005 and takes about a minute.
- Tracing (`backend/tracing.py`): one trace per run (`start-session`, `answer-message`, `apply-review`, `resume-run`), grouped by session id and tagged with the run kind. Input is the user's message (never the documents), output is the next status and the reply. The research subagents are typed `agent`, model calls are named by step (`read-documents`, `research-target`, `analyze-fit`, `rewrite-documents`, `check-rewrites`, `reply-to-user`), LangChain's parser and router spans are dropped, emails and phone numbers are masked before export, and a failed step is recorded by its error type only (`backend/errors.py`), never its message. Tracing never raises into a run. The Langfuse settings are read in `backend/settings.py`. Each generation keeps the model's reasoning summary (`additional_kwargs.reasoning_content`) when OpenRouter returns one; `gpt-6-luna` gives a readable summary only for longer reasoning, otherwise only an encrypted blob, which is dropped at export. `LANGFUSE_TRACING_ENVIRONMENT` is `development` in compose and `production` on Render.
- `TEST_DATABASE_URL` should point at its own database (e.g. `agentic_test`), not the dev one: its stub calls count against the daily budget.

## Next: evals and deploy
1. `uv run python -m evals.run` → baseline numbers for the README.
2. Supabase: create the project, take the session pooler URL (port 5432) as `DATABASE_URL`. Set `DEMO_PASSCODE`.
3. Push to GitHub → Render "New Blueprint" → set the secrets (`OPENROUTER_API_KEY`, `TAVILY_API_KEY`, `DATABASE_URL`, `DEMO_PASSCODE`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`) → deploy → smoke test `/api/health` and one session.

## Known limits (v1)
- Follow-up fixes (2026-11-08): saved analysis replacement now requires `/reanalyze`; chat can read reviewed documents and current keyword coverage. Evidence-backed missing terms get a bounded writer retry and code checks in the critic; unsupported terms remain explicit gaps. Review starts undecided, and bulk acceptance preserves edits and rejections. Exact public LinkedIn URLs supplied in documents or chat before analysis can be audited through Tavily advanced search with raw content; unavailable profiles continue clearly labelled resume-based preparation, optionally using bounded supplied-link and official-guidance research. Offline behavioral regressions and eval quality gates were added. The real-Postgres restart/persistence check passed against an isolated test database; live-provider eval baselines remain unrun.
- One API worker by design (runs, event bus and budget live in-process). Scaling out needs a shared queue and Postgres LISTEN/NOTIFY for the bus.
- Models run through `langchain-openrouter` (`ChatOpenRouter`), which reports OpenRouter's `usage.cost` and the reasoning, streamed too, and passes reasoning back in tool loops. If a provider omits the cost, tokens are still recorded but the call counts $0 against the daily budget. `langchain-openrouter` pins the `openrouter` SDK below 1.0, which pins pydantic below 2.13 (we're on 2.12.5).
- The SDK retries 5XX by itself; 429s, timeouts and network errors are retried by the researchers' `RetryPolicy`.
- A failing tool tells the concierge only its error type; invalid arguments keep LangGraph's message (the model's own arguments) so it can correct the call.
- With LangGraph 1.2, `Command(resume=...)` crashes on an empty value, so the review always resumes with `{"decisions": ...}` (`agent/nodes/review.resume_with`).
- LangGraph uses the `run_id` metadata key itself; our run id is under `app_run_id`.

## Product improvements (2026-11-08)

- Resume extraction now preserves employment/project/volunteer kinds and original section headings; renderers keep grouping, source order and retained sections. Project dates are not treated as missing employment dates. Evidence checks guard against attributing project skills to unrelated jobs.
- Advisory chat reads saved documents and analysis during pending review without resuming the interrupted graph. Suggestions are checked drafts loaded explicitly into Edit; saved amendments and review submissions support version checks. Browser drafts survive conflicts and require explicit reconciliation. Fresh analysis requires a separate confirmation, including its exact target.
- LinkedIn output distinguishes profile audits from resume-only preparation, retains retrieval limitations and sources, and supplies named fields, placement instructions, paragraph-preserving copy and advisory character counts. Guidance is versioned and cached; unverified limits remain advisory. Supplementary candidate facts require confirmation.
- Evaluations include a labelled mixed-career/project fixture and source-structure quality gate, keyword and unsupported-number checks. Legacy serialized pending-checkpoint compatibility is tested.
- Verification: Ruff passed; **114 offline Python tests passed** (Postgres skipped in that invocation); **1 real-Postgres integration test passed** separately against `agentic_product_test`, covering restart and persisted advisory conversation with stub models. No real model/provider evaluation or paid research call was made. See `docs/REVIEW_PRODUCT_IMPROVEMENTS.md` for the review rationale and remaining quality-baseline limit.
- Frontend verification: **28 tests passed**, production build and ESLint/Prettier passed. Desktop (1440px) and mobile (390px) mock-browser checks passed with review-time chat enabled, preserved line breaks and no horizontal overflow; no application API/provider calls were made by that browser check. Argon coded UI work and Opus reviewed backend changes through Herdr; both agents were closed.
