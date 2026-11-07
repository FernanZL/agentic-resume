# Agentic Resume

**A multi-agent resume and LinkedIn optimizer.** You chat with an assistant, hand it your resume (and optionally your LinkedIn export) and the role you're aiming for. It sends out a team of research agents in parallel, measures the gap, writes rewrites grounded in your own documents, has a critic fact-check them, and waits for your decision on every change before you export.

Built with LangGraph, FastAPI and React, as a portfolio project that also does a real job.

## How it works

```mermaid
flowchart LR
    U([You]) <--> C[Concierge<br/>chat agent]
    C -- request_analysis --> A
    subgraph A [Analysis subgraph: deterministic map-reduce]
        direction LR
        I[Intake<br/>parse + screen] -->|Send| J[Job analyst]
        I -->|Send| CO[Company researcher]
        I -->|Send| M[Market analyst]
        I -->|Send| L[LinkedIn auditor]
        J & CO & M & L --> G[Gap analysis<br/>code + rubric]
        G --> RW[Resume writer] & LW[LinkedIn writer]
        RW & LW --> CR{Critic}
        CR -- flagged, ≤2 rounds --> RW & LW
        CR --> RV[[Review<br/>interrupt]]
        RV --> F[Finalize]
    end
    A --> C
    RV <-. accept / edit / reject .-> U
```

- **Concierge**: a bounded ReAct agent. It asks clarifying questions, and its `request_analysis` tool returns a `Command` that routes into the analysis **subgraph** in code, with no extra model call. Afterwards it explains the results and revises single proposals on request.
- **Research fan-out**: `Send` starts only the researchers that apply (no company research without a company, no LinkedIn audit without a profile). Each runs a private tool loop (Tavily search, fetch) capped at 4 calls, with a `RetryPolicy` on rate limits and timeouts.
- **Gap analysis**: keyword coverage and ATS format checks are counted in code; a model adds a recruiter's rubric on top.
- **Writers and critic**: an evaluator-optimizer loop. Numbers are checked against your documents in code, and anything else is judged by a model. Flagged proposals go back to their writer for at most two rewrites. Unverifiable numbers end up as `[X]` placeholders for you to fill in. Nothing is invented silently.
- **Review**: `interrupt()` inside the subgraph. The run is checkpointed in Postgres and resumes with your decisions, even after a restart.

## What it shows

| | |
|---|---|
| Agent orchestration | Native LangGraph subgraph, conditional routing, `Send` fan-out with `max_concurrency`, `RetryPolicy`, `interrupt`/`Command(resume)`, reducers built so parallel branches and rewrites never collide, tools returning `Command`, `context_schema` |
| Grounding and safety | Code-level evidence checks, critic loop, placeholders, mandatory human review, prompt-injection screening, sanitized web fetches (SSRF-safe) |
| Production concerns | Postgres checkpoints that survive restarts, SSE live timeline with gap-free replay (`Last-Event-ID`), a daily cost breaker with per-call reservations, a passcode gate, sanitized errors, no document text in event logs or server logs |
| Engineering | Typed contracts (Pydantic), stub-model tests of every flow (no network), real-Postgres integration test, evals with a golden set and an LLM judge, Docker, Render Blueprint |

## Run it locally

```bash
cp .env.example .env          # add OPENROUTER_API_KEY (and TAVILY_API_KEY for web research)
docker compose up             # Postgres + API (hot reload) + web (Vite)
open http://localhost:5173    # API docs: http://localhost:8000/docs
```

Without Docker:

```bash
uv sync && uv run uvicorn --factory backend.main:create_app --reload   # SQLite, memory checkpoints
cd web && npm install && npm run dev
```

## Tests and evals

```bash
uv run pytest                                   # agents, API, tools, evals runner: stub models only
docker compose up -d db && TEST_DATABASE_URL=postgresql://agentic:agentic@localhost:5432/agentic \
  uv run pytest -m postgres                     # restart-and-resume on real Postgres
cd web && npm test -- --run && npm run lint
uv run python -m evals.run                      # real models on evals/cases: coverage, fabrication, judge, cost
```

## Deploy (Render)

`render.yaml` is a Blueprint for one Docker web service: FastAPI serves `/api` and the built SPA. Point `DATABASE_URL` at a Supabase Postgres (session pooler) and set `OPENROUTER_API_KEY`, `TAVILY_API_KEY` and `DEMO_PASSCODE` in the dashboard. The free plan's 512 MB and its sleep after 15 minutes idle are expected: a run cut off by sleep resumes from its checkpoint.

## Layout

```
agent/      graph.py (session graph), analysis.py (subgraph), concierge.py, nodes/, tools/, prompts/, schemas.py
backend/    main.py, routers/, runner.py (background runs → events), events.py (SSE), budget.py, database.py, export.py
web/        React + Vite + TypeScript SPA: chat, live agent timeline, review, export
evals/      golden cases and the scoring runner
docs/       SPEC (design), CONTRACT (API, events, tools), CODE_STANDARDS, STATUS
```

## Built by a team of agents

Claude (lead) designed the system with **argon** (Antigravity), owned the contracts, graphs, backend and deploy, and integrated everything. argon built the agent tools and the web app. **sol** (Codex) reviewed every phase, and its findings (SSRF, admission races, budget reservations, PII in events) were fixed before each commit. See `AGENTS.md` for the ownership rules.
