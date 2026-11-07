# syntax=docker/dockerfile:1
# Stages: base (Python deps) → dev (compose, hot reload) ; web (Vite build) → prod (Render).

FROM python:3.12-slim AS base
COPY --from=ghcr.io/astral-sh/uv:0.11 /uv /usr/local/bin/uv
ENV PYTHONUNBUFFERED=1 UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never \
    PATH="/app/.venv/bin:$PATH"
WORKDIR /app
COPY pyproject.toml uv.lock .python-version ./
RUN uv sync --frozen --no-dev --no-install-project

FROM base AS dev
RUN uv sync --frozen --no-install-project
COPY agent ./agent
COPY backend ./backend
CMD ["uvicorn", "--factory", "backend.main:create_app", "--host", "0.0.0.0", "--port", "8000", \
     "--reload", "--reload-dir", "agent", "--reload-dir", "backend"]

FROM node:26-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM base AS prod
COPY agent ./agent
COPY backend ./backend
COPY --from=web /web/dist ./web/dist
RUN useradd --create-home app  # /app stays root-owned: the app only reads it
USER app
ENV PORT=8000
EXPOSE 8000
# One worker: runs, the event bus and the budget live in this process.
CMD ["sh", "-c", "uvicorn --factory backend.main:create_app --host 0.0.0.0 --port ${PORT} --workers 1 --proxy-headers --forwarded-allow-ips='*'"]
