# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Primary: job seekers** (the author included) tailoring a resume, and optionally a LinkedIn profile, for one specific role. They arrive with a resume file and a posting or role title, and they want stronger, truthful documents they can export today. The interface must feel trustworthy and efficient.
- **Secondary: people evaluating the author's engineering** (recruiters, hiring managers, engineers), who open the public demo from a CV or GitHub. They spend a few minutes, and the product's own quality is the evidence. Being impressive has to come from being a good tool, never from showcase chrome.

## Product Purpose

Agentic Resume turns a resume plus a target role into reviewed, grounded rewrites. A chat assistant gathers the target, a team of agents researches the role, company and market in parallel, the gap is measured, writers propose changes, and a critic fact-checks them. Then the user accepts, edits or rejects every change before exporting (DOCX, Markdown, print/PDF, LinkedIn copy).

Success: the user leaves with a resume they'd send, every change was their decision, and nothing in it is invented.

## Positioning

- **A visible team of agents, not a black-box rewrite.** The user watches specialists work (researchers in parallel, a critic sending weak rewrites back) and can open every report.
- **Grounded by construction.** Numbers are checked against the user's own documents in code; unverifiable metrics become `[X]` placeholders for the user to fill in; nothing is exported without the user's review.

## Operating Context

- Session flow: upload or paste the resume (and optionally a LinkedIn "Save to PDF" export) → set the target (title required; company, posting URL or text optional) → chat with the assistant → a live timeline while the agents run → review proposals side by side → export.
- An analysis takes minutes, not seconds; progress streams live (SSE). During review, a separate assistant path can explain proposals and suggest local edit drafts while analysis remains paused. Changes require explicit review submission.
- Sessions live at `/s/<id>` and can be reopened. A run cut off by a server restart or sleep can be resumed.
- Public demo: a shared passcode and a daily cost cap guard it. Errors the user can hit include a wrong passcode, an exhausted budget, a failed run, and an interrupted run.

## Capabilities and Constraints

- Stack: React 19 + Vite + TypeScript SPA in `web/`, served by FastAPI in production. Contract: `docs/CONTRACT.md` (frozen API, SSE events, error codes).
- Pipeline steps (node names): concierge, intake, job_analyst, company_researcher, market_analyst, linkedin_auditor, gap_analysis, resume_writer, linkedin_writer, critic, review, finalize.
- Proposal states: OK, or flagged by the critic (with issues). Decisions: accept, edit, reject; anything undecided counts as rejected.
- LinkedIn input can be an export, pasted text, or an exact public profile URL supplied in the resume or chat before analysis. Public content is retrieved through Tavily's advanced search; unavailable content switches to clearly labelled preparation from the resume and role research, with bounded supplied sources and cached official guidance. An export or pasted text enables an actual profile audit. The app never logs into LinkedIn or guesses identities.
- Must work at 390 px wide; deployed on Render's free tier (cold starts after idle).

## Brand Commitments

- The name **Agentic Resume** stays.
- Authorship, links and other identity elements are open (not decided).

## Evidence on Hand

- There are no real users, testimonials, metrics or benchmarks. Never fabricate any.
- Demo content is fictional only: mock fixtures in `web/src/mock/fixtures.ts`, and eval cases in `evals/cases/`.
- Eval results (keyword coverage, fabrication, judge score) will exist after real keys are connected; they don't exist yet.

## Product Principles

1. **Show the work.** The agents are part of the value: make their parallel work, critique loops and reports legible while it happens.
2. **The user decides.** Every change is a proposal; review is a first-class step, not a confirmation dialog.
3. **Truth over polish.** Grounding signals (placeholders, critic flags, evidence) are always visible and never hidden to make output look better.
4. **A real tool first.** Efficiency and clarity for someone tailoring a resume outrank showcase effects.

## Accessibility & Inclusion

No product-specific standard has been set beyond solid WCAG AA practice: keyboard-complete review and export, readable diffs, and status not conveyed by color alone.
