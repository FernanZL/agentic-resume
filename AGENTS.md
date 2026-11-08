# Agentic Resume

A multi-agent resume and LinkedIn optimizer, built as a portfolio project. A chat assistant (LangGraph) receives a resume and a target role. It then runs research subagents in parallel (job, company, market, LinkedIn), a gap analysis, grounded writers and a critic, and pauses for the user to review the proposals before export. The backend is FastAPI and the frontend is React. It runs locally with Docker Compose and deploys to Render.

Read these in order before changing anything:
1. `docs/SPEC.md`: what the app does and why (the design)
2. `docs/CONTRACT.md`: the API, live events and tool interfaces (frozen)
3. `docs/CODE_STANDARDS.md`: how code is written here
4. `docs/STATUS.md`: what is done and what is next
5. For any UI work: `PRODUCT.md` (who it's for) and `DESIGN.md` (the visual system, "The Score"). The direction contract is in `.impeccable/surfaces/`

## Work authorization and coordination

Any agent may work in any part of this project when the user or the orchestrator agent authorizes that scope. Ownership is not tied to a particular agent or model; the original implementation assignments are historical, not access restrictions.

Several agents may work in this repo at once. Follow the current task assignments, coordinate overlapping edits with the orchestrator, and preserve other agents' and the user's work. A read-only review assignment remains read-only unless the user or orchestrator authorizes implementation.

Contract changes in `agent/schemas.py`, `backend/schemas.py`, and `docs/CONTRACT.md` must stay consistent and be coordinated with the orchestrator when one is active. Historical owner references in other documents do not override authorization under this policy.

## Commands

- `uv sync`: install Python dependencies
- `uv run pytest`: tests, which never call a real model or the network
- `uv run ruff check . && uv run ruff format --check .`: lint
- `docker compose up`: the full stack at http://localhost:5173 (API on :8000)
- `cd web && npm run dev | npm run build | npm test`
