# Contract

This is frozen for the first build. Only the lead (Claude) changes it. If you need a change, ask the lead; don't edit this file.

The source of truth for shapes is two Python files:
- `agent/schemas.py`: domain models (profile, reports, proposals, decisions)
- `backend/schemas.py`: API bodies and live events

Anything in this document that disagrees with those files is a mistake here.

## HTTP API (`/api`, JSON unless noted)

| Method & path | Body → Response | Errors |
|---|---|---|
| `GET /api/health` | → `Health` | |
| `POST /api/documents` | multipart: `kind` (`resume`\|`linkedin`) and `file` (.pdf, .docx, .txt or .md, at most 2 MB) → `DocumentCreated` | 413 too big, 415 wrong type, 422 unreadable |
| `POST /api/documents/text` | `DocumentText` → `DocumentCreated` | 422 |
| `POST /api/sessions` | `SessionCreate` → `RunAccepted` (202). Starts the first chat turn. | 404 unknown document, 409 document already used |
| `GET /api/sessions/{id}` | → `SessionSnapshot` | 404 |
| `POST /api/sessions/{id}/messages` | `MessageCreate` → `RunAccepted` (202) | 409 `run_active`, 409 `review_pending`, 429 `budget_exceeded` |
| `POST /api/sessions/{id}/review` | `ReviewSubmit` → `RunAccepted` (202) | 409 `no_review_pending`, 409 `run_active` |
| `POST /api/sessions/{id}/resume` | no body → `RunAccepted` (202). Continues an `interrupted` session. | 409 `not_interrupted` |
| `GET /api/sessions/{id}/events` | `text/event-stream`, see below | 404 |
| `GET /api/sessions/{id}/export?format=docx\|md\|html\|json` | The reviewed documents, built from the accepted and edited proposals. `docx` and `md` are attachments. `html` is a print-ready page (open it, then print or Save as PDF; strict CSP, no scripts). `json` is `{resume: CandidateProfile, linkedin: {target: text}}`, for the export panel and the LinkedIn copy buttons. Works only after review (`snapshot.reviewed`). | 409 `not_reviewed` |

Errors are always `{"detail": "<code or message>"}`.

**Passcode.** Every `POST` must carry the header `X-Demo-Passcode: <passcode>`; a wrong or missing passcode gets 401 `bad_passcode`. If the server has no `DEMO_PASSCODE` set, the header is ignored. `GET` routes have no passcode, because the session UUID works as the secret and `EventSource` can't send headers.

## Live events (SSE)

Open `GET /api/sessions/{id}/events`. To resume, send the `Last-Event-ID` header (the browser's `EventSource` does this when it reconnects on its own) or the query `?after=<id>`. On first load, use `snapshot.last_event_id`.

Each message looks like this:
```
id: 42
event: node_started
data: {"id":42,"session_id":"…","run_id":"…","type":"node_started","node":"job_analyst","data":{"label":"Analyzing the job posting"},"at":"2026-11-07T16:40:00Z"}
```
A `: ping` comment is sent every 15 s.

Events carry no document text: `report_ready` is `{kind, ok}`, `gap_ready` is `{score, keyword_coverage}`, `proposals_ready` is `{round, proposal_ids}` and `critique` is `{round, flagged_ids, final}`. When one arrives, re-fetch the snapshot (debounced) to get the content. Only the chat (`token`, `message`) streams text. `run_failed` carries a code (`budget_exceeded`, `model_error`, `invalid_model_output` or `internal_error`), never an exception message.

Event types are listed in `EventType` in `backend/schemas.py`. These are the `node` values in pipeline order:

`concierge` → `intake` → `job_analyst` · `company_researcher` · `market_analyst` · `linkedin_auditor` (these four run in parallel) → `gap_analysis` → `resume_writer` · `linkedin_writer` (parallel) → `critic` (the writers and critic repeat at most 2 more rounds) → `review` (pauses and emits `review_required`) → `finalize` → `concierge`.

After `review_required` (or whenever the session status is `review`), the UI shows the proposals for decisions and blocks chat until `POST /review`. After `run_completed`, re-fetch the snapshot.

## Agent tools (owned by argon), `agent/tools/`

Pure, testable functions, plus LangChain tool wrappers. No module-level network calls and no environment reads; keys and clients are passed in.

```python
# agent/tools/fetch_url.py
class FetchResult(BaseModel): url: str; ok: bool; title: str = ""; text: str = ""; error: str = ""
async def fetch_text(url: str, client: httpx.AsyncClient, max_chars: int = 20_000) -> FetchResult
    # httpx GET (timeout 15s, follow redirects, browser-like UA, http/https only, refuses
    # private/loopback IPs), trafilatura extract → plain text, truncated to max_chars.
    # Auth walls (e.g. linkedin.com/jobs) → ok=False, error explains "paste the posting".
def untrusted(text: str, source: str) -> str
    # Wraps web/user text for prompts: strips instruction-like patterns
    # ("ignore previous instructions", role tags, etc.), and wraps in
    # <untrusted_content source="..."> … </untrusted_content>.
def make_fetch_tool(client: httpx.AsyncClient) -> BaseTool   # name "fetch_url", returns untrusted(...) text

# agent/tools/web_search.py
def make_web_search(api_key: str) -> BaseTool
    # name "web_search", args (query: str). Tavily via langchain-tavily, max 5 results,
    # returns compact text: title, url, snippet each wrapped with untrusted().
    # Empty api_key → a tool with the same name that returns "Web search is not configured."

# agent/tools/ats.py  (deterministic, no LLM)
class Coverage(BaseModel): score: float; matched: list[str]; missing: list[str]
def normalize(term: str) -> str                      # case, punctuation, simple plurals, common aliases (js→javascript, k8s→kubernetes, …)
def keyword_coverage(text: str, keywords: list[str]) -> Coverage
def format_issues(profile: CandidateProfile) -> list[str]    # missing contact/email, roles without dates,
    # bullets > 2 lines (~220 chars), bullets without action verb/number, no summary, too long (> ~900 words), etc.
def numbers_in(text: str) -> set[str]                # "40%", "$1.2M", "3x", "12" (normalized)
def unsupported_numbers(proposed: str, source: str) -> list[str]  # numbers in proposed that are not in source; ignores [X]-style placeholders
def placeholders_in(text: str) -> list[str]         # "[X]%", "[N]", "$[Y]" …
```
