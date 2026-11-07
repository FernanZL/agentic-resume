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
- One API worker by design (runs, event bus and budget live in-process). Scaling out needs a shared queue and Postgres LISTEN/NOTIFY for the bus.
- Models run through `langchain-openrouter` (`ChatOpenRouter`), which reports OpenRouter's `usage.cost` and the reasoning, streamed too, and passes reasoning back in tool loops. If a provider omits the cost, tokens are still recorded but the call counts $0 against the daily budget. `langchain-openrouter` pins the `openrouter` SDK below 1.0, which pins pydantic below 2.13 (we're on 2.12.5).
- The SDK retries 5XX by itself; 429s, timeouts and network errors are retried by the researchers' `RetryPolicy`.
- A failing tool tells the concierge only its error type; invalid arguments keep LangGraph's message (the model's own arguments) so it can correct the call.
- With LangGraph 1.2, `Command(resume=...)` crashes on an empty value, so the review always resumes with `{"decisions": ...}` (`agent/nodes/review.resume_with`).
- LangGraph uses the `run_id` metadata key itself; our run id is under `app_run_id`.
