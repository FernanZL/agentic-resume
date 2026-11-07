# Status

| Phase | Owner | State |
|---|---|---|
| 0. Scaffold + contract | Claude | done |
| 1. Agent tools (`agent/tools/`) | argon | done; sol's SSRF and size fixes in progress |
| 2. Graphs (concierge + analysis subgraph) | Claude | done, reviewed by sol, fixes applied |
| 3. Backend (API, SSE, budget, persistence) | Claude | done, reviewed by sol, fixes applied |
| 4. Web SPA (`web/`, impeccable) | argon | built; adapting to ids-only events |
| 5. Docker, Render Blueprint, evals | Claude | done (evals moved from argon to Claude) |
| 6. Connect real keys + deploy | user + Claude | todo: needs OPENROUTER_API_KEY, TAVILY_API_KEY, Supabase DATABASE_URL, DEMO_PASSCODE, optional Langfuse keys |

## Notes
- Check the default OpenRouter model ids (`MODEL_DEFAULT`) once the key is in: `curl https://openrouter.ai/api/v1/models`.
- With LangGraph 1.2, `Command(resume=...)` crashes on an empty value, so the review always resumes with `{"decisions": ...}` (`agent/nodes/review.resume_with`).
- LangGraph uses the `run_id` metadata key itself; our run id is under `app_run_id`.
