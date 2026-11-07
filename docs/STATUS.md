# Status

| Phase | Owner | State |
|---|---|---|
| 0. Scaffold + contract | Claude | done |
| 1. Agent tools (`agent/tools/`) | argon | done, reviewed twice by sol (SSRF, DNS-rebinding pinning, size cap) |
| 2. Graphs (concierge + analysis subgraph) | Claude | done, reviewed by sol, fixes applied |
| 3. Backend (API, SSE, budget, persistence, exports) | Claude | done, reviewed by sol, fixes applied |
| 4. Web SPA (`web/`) | argon, then a redesign by Claude | Rebuilt through the impeccable process: user-chosen direction "The Score", finish review disposition ship, documented in DESIGN.md |
| 5. Docker, Render Blueprint, evals | Claude | done (evals moved from argon to Claude) |
| 6. Connect real keys, run evals, deploy | user + Claude | **next** |

## Next: connect and deploy
1. Keys: `OPENROUTER_API_KEY` (required), `TAVILY_API_KEY` (web research), `DEMO_PASSCODE`, Supabase `DATABASE_URL` (session pooler, port 5432), optional `LANGFUSE_*`.
2. Check the model ids: `curl https://openrouter.ai/api/v1/models`; set `MODEL_DEFAULT` (and per-role `MODEL_*` if useful).
3. `docker compose up` → a real session end to end; `uv run python -m evals.run` → baseline numbers for the README.
4. Push to GitHub → Render "New Blueprint" → set the secrets → deploy → smoke test `/api/health` and one session.

## Known limits (v1)
- One API worker by design (runs, event bus and budget live in-process). Scaling out needs a shared queue and Postgres LISTEN/NOTIFY for the bus.
- Cost of streamed concierge calls depends on OpenRouter reporting `usage.cost` in the stream; if it's missing, tokens are still recorded.
- With LangGraph 1.2, `Command(resume=...)` crashes on an empty value, so the review always resumes with `{"decisions": ...}` (`agent/nodes/review.resume_with`).
- LangGraph uses the `run_id` metadata key itself; our run id is under `app_run_id`.
