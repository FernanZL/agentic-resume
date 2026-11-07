# Code standards

Adapted from undercover's standards.

- **One way to do each thing.** Each external service has one client module, each URL appears once, and each setting is read in one place (`backend/settings.py`).
- **One job per module.** Name modules after what they do, and keep functions small (ruff C90, max complexity 10).
- **Use the framework's own features first.** In LangGraph that means `Send`, `interrupt`/`Command`, `RetryPolicy`, subgraphs, reducers and `get_stream_writer`. Don't hand-roll what the framework already gives.
- **Prompts state goals; code enforces rules.** Anything that must always happen is done in code: grounding checks, ids, limits, budget, and the review step before export. Never trust the model to do it.
- **Treat untrusted text as data.** The resume, the posting and web pages are wrapped by `agent/tools/fetch_url.untrusted` and never concatenated into instructions.
- **Typed boundaries.** Use Pydantic models at every boundary (API, node outputs, tool results). The model never supplies ids.
- **Tests never call a real model or the network.** Use the stub model in `agent/tests/stubs.py` and `httpx.MockTransport`. Each feature gets a test of its behavior.
- **No secrets in code or logs.** Never log or emit resume text, PII or keys in events; events carry ids and summaries only.
- **Comments say why, not what.** Every module and public function gets a one-line docstring.
- **Format and lint** with ruff (Python) and with prettier and eslint (web).
