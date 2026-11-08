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

- **Concierge**: a bounded ReAct agent. It asks clarifying questions, and its `request_analysis` tool returns a `Command` that routes into the analysis **subgraph** in code, with no extra model call. Afterwards it explains the results and drafts checked rewrites of single proposals; nothing is applied until you load a draft into Edit and submit it.
- **Research fan-out**: `Send` starts only the researchers that apply (no company research without a company). Each runs a private tool loop (Tavily search, fetch) capped at 4 calls, with a `RetryPolicy` on rate limits and timeouts.
- **LinkedIn**: with an export or pasted profile, the auditor audits it. With your exact `https://www.linkedin.com/in/...` URL (in the resume or in chat, before the analysis), Tavily advanced search retrieves that profile and nothing else. Otherwise the app prepares LinkedIn copy from your resume and labels it as such, using at most two portfolio or repository pages you supplied and one search for official guidance (cached by role for 24 hours). Character counts are advisory. The app never logs into LinkedIn or guesses identities.
- **Gap analysis**: keyword coverage and ATS format checks are counted in code, on short keywords (requirement sentences such as "2+ years of X" are left out); a model adds a recruiter's rubric on top, and quotes your resume for every missing keyword it says you can claim.
- **Writers and critic**: an evaluator-optimizer loop. Code checks that numbers come from your documents, that no text talks about the job posting instead of you, and that the summary doesn't repeat the bullets; a model judges the rest (invented claims, inflated wording, tone). Flagged proposals go back to their writer for at most two rewrites. Unverifiable numbers end up as `[X]` placeholders for you to fill in. Nothing is invented silently.
- **Review**: `interrupt()` inside the subgraph. The run is checkpointed in Postgres and resumes with your decisions, even after a restart. Every proposal starts undecided; bulk acceptance keeps your edits and rejections.
- **Conversation around the review**: while the review is pending, you can still ask about your documents and the analysis; that chat reads the saved session without resuming the interrupted graph. Afterwards, finished documents can be amended without a full rerun. Submissions carry a version, so a stale review is refused, and running a fresh analysis needs its own confirmation.
- **Section fidelity**: intake keeps employment, projects and volunteering apart, with their original headings and order, and exports keep that structure. Evidence checks stop project skills from being credited to unrelated jobs.

## The interface

The live run is drawn as an orchestral score: one staff per agent on a shared time axis. Work is beams, tool calls are noteheads, the critic's rewrite rounds sit inside repeat barlines, and the review is a fermata, where the run waits for you. Vermilion only ever means "now". The design system is in `DESIGN.md`.

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
open http://localhost:5173    # API docs: http://localhost:8001/docs
```

Without Docker:

```bash
uv sync && uv run uvicorn --factory backend.main:create_app --reload   # SQLite, memory checkpoints
cd web && npm install && npm run dev
```

## Tests and evals

The offline suite uses stub models and never touches the network. Its regressions cover accidental reruns, reviewed exports surviving follow-ups, supported keyword rewrites, exact-profile retrieval, mixed career sections and an old-format pending checkpoint. UI tests cover undecided proposals, bulk acceptance, retained edits and rejections, and saved decisions.

The eval runner uses real models on the golden cases in `evals/cases/`: a career changer whose projects sit next to unrelated earlier work, two step-ups to senior, a domain change, a resume with instructions hidden for the AI, and a new graduate with almost no evidence. It accepts every proposal and scores the result in two layers:

- **Quality gates, counted in code**: the analysis completes, no matched keyword is lost, every keyword the evidence supports is used, no number is absent from the candidate's documents, labelled sections and attributions survive, hidden instructions are flagged and never obeyed, and no proposal talks about the posting instead of the candidate. Any failure fails the run.
- **Measurements**: evidence coverage (the share of the keywords the candidate can honestly claim that the result uses), and two judges on a model from another family than the app's (Gemini 3.6 Flash, so the app never grades itself). The *faithfulness* judge checks every claim of every proposal against the submitted documents. The *tailoring* judge rates how well the result presents the evidence that exists, without penalising the qualifications the candidate lacks.

Each case runs three times, and the report gives the spread, because one run is mostly noise. With Langfuse keys, the cases are synced to the dataset `agentic-resume-golden`, and each repeat is a Langfuse experiment with the full trace and scores of every item, so runs can be compared side by side. Without keys, or with `--local`, the same scorers run locally. Results are also saved in `evals/results/`. A run spends provider credits, so it is kept apart from the offline checks.

The baseline, the fixes it led to (including a regression the evals caught), and the current numbers (16 of 18 sessions pass every gate, the injection is resisted in every run, no invented numbers, no leaked reasoning) are written up with charts in [`docs/portfolio/evals/`](docs/portfolio/evals/README.md).

```bash
uv run pytest                                   # agents, API, tools, evals runner: stub models only
docker compose up -d db && TEST_DATABASE_URL=postgresql://agentic:agentic@localhost:5432/agentic \
  uv run pytest -m postgres                     # restart-and-resume on real Postgres
cd web && npm test -- --run && npm run lint
uv run --env-file .env python -m evals.run     # real models, 3 repeats, Langfuse experiments
uv run --env-file .env python -m evals.run --local --repeats 1 sparse-resume   # one case, no Langfuse
uv run --env-file .env python -m evals.rescore evals/results/<run>.json        # rescore saved outputs (judges only)
```

## Deploy (Render)

`render.yaml` is a Blueprint for one Docker web service: FastAPI serves `/api` and the built SPA. Point `DATABASE_URL` at a Supabase Postgres (session pooler) and set `OPENROUTER_API_KEY`, `TAVILY_API_KEY` and `DEMO_PASSCODE` in the dashboard. The free plan's 512 MB and its sleep after 15 minutes idle are expected: a run cut off by sleep resumes from its checkpoint.

## Layout

```
agent/      graph.py (session graph), analysis.py (subgraph), concierge.py, nodes/, tools/, prompts/, schemas.py
backend/    main.py, routers/, runner.py (background runs → events), events.py (SSE), budget.py, database.py, export.py
web/        React + Vite + TypeScript SPA: chat, live agent timeline, review, export
evals/      golden cases, the scoring runner, its judges and the rescorer
docs/       SPEC (design), CONTRACT (API, events, tools), CODE_STANDARDS, STATUS, product review notes,
            portfolio/ (eval write-up, charts and raw results)
PRODUCT.md  who the app is for; DESIGN.md the visual system ("The Score")
```

## Built by a team of agents

Claude (lead) designed the system with **argon** (Antigravity), built the contracts, graphs, backend and deploy, and integrated everything. argon built the agent tools and the original web app, which Claude later redesigned. **sol** (Codex) reviewed every phase, and its findings (SSRF, admission races, budget reservations, PII in events) were fixed before each commit. Those assignments are history, not access rules: any agent may work in any part of the repo when the user or the orchestrator authorizes it. See `AGENTS.md` for how agents coordinate.
