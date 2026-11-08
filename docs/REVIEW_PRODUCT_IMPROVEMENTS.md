# Product review: resume fidelity, conversation and LinkedIn

Date: 2026-11-08. Status: implemented locally; provider quality baseline measured the same day (see `docs/portfolio/evals/README.md`).

Implementation followed this review: typed source sections, preserved exports, review-time advisory chat with explicit draft loading, versioned review/amendment, confirmed reruns, bounded LinkedIn fallback research, field-specific copy guidance, and regression gates. Argon implemented the frontend through Herdr; Opus independently reviewed the backend and checked the fixes. The coordinator completed integration and verification. Both worker panes were closed when finished.

Verification: 114 offline Python tests passed; the separate real PostgreSQL restart/persistence test passed against an isolated test database. Frontend tests, build and lint and desktop/mobile mock-browser checks are recorded in STATUS.md. An older serialized pending checkpoint is covered. These checks use stub models and do not establish real-provider extraction or writing quality. No paid application/provider evaluations were run.

The findings and recommendations below describe the pre-change review, retained as rationale.

Reviewed through Herdr with Claude Opus (`opus-review`, Claude Pro) and Gemini argon (`argon-review`, Google AI Pro), using the user's authorized subscription quotas. Both inspected local source and reviewed proposals relayed by the coordinator. No application/provider test calls, web research, paid evaluations, private documents or session databases were used. The coordinator recorded this report; reviewers made no application changes.

## Confirmed causes

- **Projects and employment share one untyped list.** `agent/schemas.py` calls `Experience` a role or project; it has no entry kind or original section heading. `agent/render.py`, `backend/export.py`, `web/src/components/ExportPanel.tsx` and `web/src/api.ts` render this list under Experience. Intake cannot preserve a distinction absent from the schema. ATS checks also require employment dates on projects.
- **Preview and export disagree.** Frontend preview and copied Markdown omit certifications, languages and other sections that backend renderers support. `formatProfileAsMarkdown` also substitutes the target job title for the approved headline when given `targetTitle`.
- **The assistant cannot help during review.** The messages endpoint returns `409 review_pending`; the UI hides the composer. `revise_proposal` only edits an existing proposal after review, and automatically accepts even a critic-flagged revision. Document sections without proposal targets cannot be edited through that tool.
- **LinkedIn fallback stops at retrieval.** `agent/nodes/research.py` returns an error when the public profile is unavailable. The LinkedIn writer still runs from the resume, without a clear distinction between an actual profile audit and resume-based preparation.
- **LinkedIn copy is difficult to apply.** `.diff-text` does not preserve line breaks. Experience text can include title, company and dates mixed with description copy. Labels expose `exp0` instead of the role name. Output lacks field-specific placement instructions and code-enforced field constraints.
- **Passing stub tests do not prove extraction quality.** The default intake stub returns the same simplified profile irrespective of the submitted resume. It cannot expose project/employment classification failures on real inputs.

## Recommended delivery order

### 1. Fix visible output and unsafe revisions

Preserve proposal paragraphs and bullets. Label entries with their actual role/project names. Bring preview, copied Markdown and downloaded documents into agreement, including the approved headline and all retained sections. Do not automatically apply generated revisions that are flagged or have not been reviewed.

These changes require no additional calls during a normal analysis.

### 2. Preserve what the resume actually says

Keep existing entry and bullet IDs so saved proposals and decisions continue to identify the same material. Add entry kind and source section heading, with an unclassified legacy default. Preserve source grouping and order across renderers; offer any regrouping as a reviewable change. Do not silently discard unrelated employment or present it as target-role employment. Projects remain projects, including when they provide useful evidence of a skill.

Make date checks depend on entry kind. Track the entries supporting a proposal and check attribution against them. A word blacklist alone cannot establish whether a project was misrepresented as a job.

Compatibility must be demonstrated with an actual older serialized checkpoint, including a pending review, rather than assumed from Pydantic field defaults.

### 3. Make LinkedIn output an editing workflow

Distinguish an uploaded/public-profile audit from **preparation based on the resume**. When a profile is private, explain that the current profile was not inspected and continue useful preparation. Keep genuine tool/configuration failures distinguishable from expected private-profile fallback.

Each proposed change should identify the LinkedIn section and field, the named role where applicable, paste-ready text, placement instructions, a character count, rationale/evidence and unresolved confirmations. Experience description copy must exclude title/company/date fields. Include supported skills suggestions and preserve paragraph formatting. Copy controls for final content use the user's accepted or edited text.

Guidance and platform limits need attributable, dated verification before being advertised as current hard constraints. Cache/version reusable official guidance; do not repeat generic best-practice searches every run. Reuse role/company/market research. Supplement it only when useful with bounded retrieval of candidate-supplied portfolio or repository URLs and relevant authoritative guidance. Web-derived candidate claims require confirmation; never guess identity or imply an inaccessible profile was inspected. This review performed no external research.

### 4. Make the assistant useful throughout the session

Allow review-time questions through a separate read-only conversational path over the saved snapshot, with useful role labels, current documents and decisions. Preserve the analysis interrupt and its pending review. Do not simply remove the HTTP guard and invoke the interrupted parent graph with a new message.

Argon's useful refinement: a response can suggest an edit for an existing proposal, with an explicit **Load into Edit** action that updates the browser's review draft. Normal review submission then applies the user's decision. This avoids mutating the paused graph merely to discuss or stage wording. Generated suggestions must retain their validation status and concerns; loading a draft must not silently label it critic-passed or auto-accept it. More general server-side proposal changes need explicit versioning, locking and separate tests.

Support requests expressed using section/role names, not internal proposal IDs. Replace the `/reanalyze` requirement with a clear confirmation action while preserving a deterministic guard against unintended replacement of saved results.

## Discussion points resolved or still open

- Both reviewers oppose splitting/renumbering existing entries or adding more default agent calls as the first fix.
- Opus favored exact source headings; argon favored a few normalized ATS headings. Recommendation: preserve the source by default and make normalization optional and reviewable. Entry kind and source heading are separate concepts.
- Both support a read-only review-time question path. Argon's client-draft bridge is preferable to casually mutating the interrupted checkpoint. Validation and draft freshness remain implementation requirements.
- Both favor useful, targeted evidence over indiscriminately increasing search depth. Stable guidance can be curated and cached; deeper role/candidate research should resolve identifiable gaps and retain source provenance.
- Whether a different concierge model is necessary remains unproven. Fix the tool, context and interaction restrictions first; judge model behavior later on labelled conversations.

## Offline acceptance gates

1. A fixture containing relevant jobs, unrelated employment, undated projects and volunteering keeps its distinctions, original facts and stable IDs through review and every output format.
2. Preview, copied text, Markdown, HTML and DOCX preserve the same reviewed content, including additional sections and headline.
3. An older serialized checkpoint loads without reassigning decisions; an older pending review resumes successfully.
4. An unavailable/private profile produces clearly labelled resume-based preparation, without pretending to audit unseen fields. Each LinkedIn item is actionable, field-specific and readable.
5. A review-time question leaves the analysis checkpoint and interrupt intact. A suggested edit changes only the client draft until explicitly submitted; rejected, stale or flagged suggestions never silently become accepted output.
6. Follow-ups, corrections and questions do not trigger full analysis. A deliberate rerun requires explicit confirmation.
7. Count calls in stub tests and mock every external request. Do not claim stub results establish real extraction or conversation quality. Any later live evaluation requires separate authorization under the user's current cost restriction.
