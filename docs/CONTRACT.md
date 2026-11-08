# Contract

This is frozen for the first build. Changes require authorization from the user or orchestrator under `AGENTS.md`; coordinate API, schemas and consumers together.

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
| `POST /api/sessions/{id}/ask` | `AskRequest {content, proposal_id?}` → `AskResponse {message, suggestion?, revision}` synchronously. Budgeted conversation over saved results; does not invoke or update the analysis graph. | 409 `run_active` / `session_not_ready`, 422 invalid target, 429 budget, 502 model error code |
| `POST /api/sessions/{id}/amend` | `ReviewSubmit {decisions, additions?, expected_revision}` → `SessionSnapshot`. Explicitly applies reviewed changes to a finished idle session. | 409 `not_reviewed`, `run_active`, `stale_review`; 422 missing revision/invalid target |
| `POST /api/sessions/{id}/reanalyze` | `{target: TargetJob, confirmed: true}` → `RunAccepted` (202). Explicit confirmation replaces saved results and deterministically runs the exact target. | 409 `review_pending` / `run_active`, 422 no confirmation, 429 budget |
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

After `review_required` (or whenever status is `review`), analysis remains paused until `POST /review`. The UI can still discuss proposals through `/ask`, which leaves the checkpoint and interrupt unchanged. It returns an optional checked draft for an existing or valid new target. Loading that draft only changes browser review state; applying it requires explicit `/review` or `/amend` submission. After `run_completed`, re-fetch the snapshot.

`SessionSnapshot.profile` supplies original entry context and `revision` versions proposals/decisions independently of advisory chat. `ReviewSubmit.additions` stages new valid source-field targets: the server derives ids and originals itself. `expected_revision` detects stale submissions; required for `/amend`, optional on the legacy `/review` endpoint. New clients send it on both. Advisory history is persisted separately and merged into snapshot messages around its original conversation anchor.

`Experience.kind` defaults to `unclassified` for legacy checkpoints; `source_section` defaults to empty. Stable `expN` and `expN.bN` ids do not change. `LinkedInAudit.basis` distinguishes uploaded `profile`, fetched `public` content and `resume_only` preparation, with sources and limitations. An unavailable current profile does not prevent preparation. Export JSON also includes `linkedin_guidance`, keyed by target, with section, field, instructions, advisory character limit, source URL and explicit verification status. Guidance is not a claim of live platform verification.

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

# agent/tools/linkedin.py
def make_linkedin_search(api_key: str) -> BaseTool
    # name "linkedin_profile_search", args (url: str). Tavily advanced search,
    # include_domains=["linkedin.com/in"], include_raw_content=True, max 5 results.
    # Only returns bounded, untrusted-wrapped content for the exact supplied profile URL.
    # Missing key/content → "Unavailable: ..." with instructions to upload/paste the profile.

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
