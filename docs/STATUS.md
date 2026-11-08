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
| 6b. Evals: judges, repeats, Langfuse experiments, baseline | user + Claude | done 2026-11-08: 16/18 runs pass the gates; report in `docs/portfolio/evals/` |
| 6c. Fix what the baseline found, rerun | Claude | done 2026-11-08: two rounds (round 1 regressed, caught by the evals); 16/18 runs pass, no leaked reasoning |
| 6e. Keyword policy (product-manager case) | user | decided 2026-11-08: keep the strict rule (see Known limits) |
| 6d. Deploy to Render + Supabase | user + Claude | **next** |

## Local run (verified 2026-11-07)
- Keys in `.env`: OpenRouter, Tavily, Langfuse (US region, `LANGFUSE_BASE_URL`). `openai/gpt-6-luna` exists on OpenRouter and supports tools ($0.10/M in, $0.50/M out); a full session (research, gap, 1–3 writer/critic rounds, review) costs about $0.005 and takes about a minute.
- Tracing (`backend/tracing.py`): one trace per run (`start-session`, `answer-message`, `apply-review`, `resume-run`), grouped by session id and tagged with the run kind. Input is the user's message (never the documents), output is the next status and the reply. The research subagents are typed `agent`, model calls are named by step (`read-documents`, `research-target`, `analyze-fit`, `rewrite-documents`, `check-rewrites`, `reply-to-user`), LangChain's parser and router spans are dropped, emails and phone numbers are masked before export, and a failed step is recorded by its error type only (`backend/errors.py`), never its message. Tracing never raises into a run. The Langfuse settings are read in `backend/settings.py`. Each generation keeps the model's reasoning summary (`additional_kwargs.reasoning_content`) when OpenRouter returns one; `gpt-6-luna` gives a readable summary only for longer reasoning, otherwise only an encrypted blob, which is dropped at export. `LANGFUSE_TRACING_ENVIRONMENT` is `development` in compose and `production` on Render.
- `TEST_DATABASE_URL` should point at its own database (e.g. `agentic_test`), not the dev one: its stub calls count against the daily budget.

## Evals (2026-11-08)
- `evals/run.py`: code quality gates (now including `no_meta_commentary`) plus two judges on another model family (`evals/judges.py`, Gemini 3.6 Flash, `JUDGE_VERSION` 2, one retry on a non-structured answer), 3 repeats per case, cases synced to the Langfuse dataset `agentic-resume-golden`, each repeat a Langfuse experiment. `--local` skips Langfuse. `evals/rescore.py` rescores saved outputs (judge calls only). Needs `uv run --env-file .env` (the runner doesn't read `.env` itself).
- Baseline → round 2 (same scorers): gates 15/18 → 16/18, leaked reasoning 1 → 0, summaries in their own words 78% → 94%, faithfulness 98% → 98%, tailoring 2.89 → 3.00, flagged after the last critic round 0.6 → 0.4, $0.006 per session. Round 1 regressed two cases; the cause (missing-keyword feedback sent to every bullet, and a gap/critic disagreement on "design system") was fixed in round 2. Full story, charts and raw results: `docs/portfolio/evals/README.md`.
- Code checks added from the findings: `gap.keyword_terms` (no requirement sentences or durations as keywords; alternatives split), `critic.META` / `meta_issues`, `critic.repetition_issues` (summary vs bullets, 6 words), `critic.keyword_carrier` (missing keywords asked of one proposal).

## Next
1. Supabase: create the project, take the session pooler URL (port 5432) as `DATABASE_URL`. Set `DEMO_PASSCODE`.
2. Push to GitHub → Render "New Blueprint" → set the secrets (`OPENROUTER_API_KEY`, `TAVILY_API_KEY`, `DATABASE_URL`, `DEMO_PASSCODE`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`) → deploy → smoke test `/api/health` and one session.

## Known limits (v1)
- Keyword policy (decided 2026-11-08: keep as is). Every missing keyword the gap analysis supports with a quote must appear verbatim (the critic's `keyword_issues` and the eval gate `supported_keywords_covered`). That favours ATS matching. For postings with generic wording (the product-manager case: ~8 terms such as "Product delivery", "Product roadmap"), the writer crams them in and recruiters read it as stuffing: the case passes the gates in 1 of 3 runs, with tailoring 1.7/5. The alternative, requiring only the 3–5 most important terms, is described in `docs/portfolio/evals/README.md`.
- Follow-up fixes (2026-11-08): saved analysis replacement now requires `/reanalyze`; chat can read reviewed documents and current keyword coverage. Evidence-backed missing terms get a bounded writer retry and code checks in the critic; unsupported terms remain explicit gaps. Review starts undecided, and bulk acceptance preserves edits and rejections. Exact public LinkedIn URLs supplied in documents or chat before analysis can be audited through Tavily advanced search with raw content; unavailable profiles continue clearly labelled resume-based preparation, optionally using bounded supplied-link and official-guidance research. Offline behavioral regressions and eval quality gates were added. The real-Postgres restart/persistence check passed against an isolated test database; the live-provider eval baseline followed the same day (see Evals).
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
