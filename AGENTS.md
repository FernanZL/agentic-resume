# Agentic Resume

A multi-agent resume and LinkedIn optimizer, built as a portfolio project. A chat assistant (LangGraph) receives a resume and a target role. It then runs research subagents in parallel (job, company, market, LinkedIn), a gap analysis, grounded writers and a critic, and pauses for the user to review the proposals before export. The backend is FastAPI and the frontend is React. It runs locally with Docker Compose and deploys to Render.

Read these in order before changing anything:
1. `docs/SPEC.md`: what the app does and why (the design)
2. `docs/CONTRACT.md`: the API, live events and tool interfaces (frozen)
3. `docs/CODE_STANDARDS.md`: how code is written here
4. `docs/STATUS.md`: what is done and what is next

## Who owns what

Several agents work in this repo at once. Edit only your own paths.

| Path | Owner |
|---|---|
| `agent/schemas.py`, `backend/schemas.py`, `docs/CONTRACT.md` (the contract) | Claude (lead) |
| `agent/` (graphs, nodes, prompts), `backend/`, Docker, `render.yaml` | Claude (lead) |
| `agent/tools/` (and its tests in `agent/tools/tests/`) | argon |
| `web/` | argon |
| reviews (read-only) | sol |

## Commands

- `uv sync`: install Python dependencies
- `uv run pytest`: tests, which never call a real model or the network
- `uv run ruff check . && uv run ruff format --check .`: lint
- `docker compose up`: the full stack at http://localhost:5173 (API on :8000)
- `cd web && npm run dev | npm run build | npm test`
