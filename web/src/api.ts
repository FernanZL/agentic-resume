/**
 * Typed API client and domain/contract types mirroring agent/schemas.py and backend/schemas.py.
 */

import { HttpError, request } from "./connection";
import {
  MOCK_CANDIDATE_PROFILE,
  MOCK_GAP_REPORT,
  MOCK_PROPOSALS,
  MOCK_REPORTS,
  MOCK_RUN_ID,
  MOCK_SESSION_ID,
  createDemoReviewMockSnapshot,
  createInitialMockSnapshot,
  createMockDocument,
} from "./mock/fixtures";

// ---------------------------------------------------------------- agent/schemas.py

export interface Bullet {
  id: string;
  text: string;
}

export interface Experience {
  id: string;
  title: string;
  organization: string;
  location: string;
  start: string;
  end: string;
  bullets: Bullet[];
}

export interface Education {
  degree: string;
  institution: string;
  year: string;
  details: string;
}

export interface CandidateProfile {
  name: string;
  headline: string;
  contact: string[];
  summary: string;
  experience: Experience[];
  education: Education[];
  skills: string[];
  certifications: string[];
  languages: string[];
  other: string[];
}

export interface LinkedInProfile {
  headline: string;
  about: string;
  experience: Experience[];
  skills: string[];
}

export interface TargetJob {
  title: string;
  company: string;
  job_url: string;
  job_text: string;
  notes: string;
}

export type ReportKind = "job" | "company" | "market" | "linkedin";

export interface Source {
  title: string;
  url: string;
}

export interface JobAnalysis {
  summary: string;
  seniority: string;
  must_have: string[];
  nice_to_have: string[];
  responsibilities: string[];
  keywords: string[];
  sources: Source[];
}

export interface CompanyBrief {
  summary: string;
  products: string[];
  tech_stack: string[];
  values: string[];
  tone: string;
  recent_news: string[];
  sources: Source[];
}

export interface MarketBrief {
  summary: string;
  title_variants: string[];
  in_demand_skills: string[];
  level_signals: string[];
  sources: Source[];
}

export interface LinkedInAudit {
  summary: string;
  headline_issues: string[];
  about_issues: string[];
  experience_gaps: string[];
  inconsistencies: string[];
}

export interface Report {
  kind: ReportKind;
  job: JobAnalysis | null;
  company: CompanyBrief | null;
  market: MarketBrief | null;
  linkedin: LinkedInAudit | null;
  error: string;
}

export interface GapReport {
  score: number;
  keyword_coverage: number;
  matched_keywords: string[];
  missing_keywords: string[];
  format_issues: string[];
  weak_bullets: string[];
  strengths: string[];
  priorities: string[];
}

export type DocumentType = "resume" | "linkedin";
export type ProposalStatus = "ok" | "flagged";

export interface Proposal {
  id: string;
  document: DocumentType;
  target: string;
  original: string;
  proposed: string;
  rationale: string;
  keywords: string[];
  placeholders: string[];
  issues: string[];
  status: ProposalStatus;
}

export type Action = "accept" | "reject" | "edit";

export interface Decision {
  action: Action;
  text: string;
}

export interface ReviewDraftEntry {
  action: Action;
  text: string;
  proposedAtDraft: string;
}

export function reconcileReviewDrafts(
  proposals: Proposal[],
  serverDecisions: Record<string, Decision>,
  prevDrafts: Record<string, ReviewDraftEntry>,
): Record<string, ReviewDraftEntry> {
  const next: Record<string, ReviewDraftEntry> = {};
  proposals.forEach((p) => {
    const existingDraft = prevDrafts[p.id];
    if (existingDraft && existingDraft.proposedAtDraft === p.proposed) {
      next[p.id] = existingDraft;
      return;
    }
    const serverDec = serverDecisions[p.id];
    if (!existingDraft && serverDec) {
      next[p.id] = {
        action: serverDec.action,
        text: serverDec.action === "edit" && serverDec.text ? serverDec.text : p.proposed,
        proposedAtDraft: p.proposed,
      };
      return;
    }
    next[p.id] = {
      action: p.status === "ok" ? "accept" : "reject",
      text: p.proposed,
      proposedAtDraft: p.proposed,
    };
  });
  return next;
}

export type ConciergeRole = "user" | "assistant";

// ---------------------------------------------------------------- backend/schemas.py

export type DocumentKind = "resume" | "linkedin";

export interface DocumentText {
  kind: DocumentKind;
  text: string;
}

export interface DocumentCreated {
  document_id: string;
  kind: DocumentKind;
  characters: number;
  preview: string;
}

export interface SessionCreate {
  resume_document_id: string;
  linkedin_document_id: string;
  target: TargetJob;
}

export type SessionStatus = "idle" | "running" | "review" | "interrupted" | "failed";

export interface RunAccepted {
  session_id: string;
  run_id: string;
}

export interface ChatMessage {
  id: string;
  role: ConciergeRole;
  content: string;
}

export interface MessageCreate {
  content: string;
}

export interface ReviewSubmit {
  decisions: Record<string, Decision>;
}

export interface SessionSnapshot {
  session_id: string;
  status: SessionStatus;
  created_at: string;
  target: TargetJob;
  has_linkedin: boolean;
  messages: ChatMessage[];
  reports: Record<string, Report>;
  gap: GapReport | null;
  proposals: Proposal[];
  decisions: Record<string, Decision>;
  reviewed: boolean;
  cost_usd: number;
  last_event_id: number;
}

export interface ExportJson {
  resume: CandidateProfile;
  linkedin: Record<string, string>;
}

export type EventType =
  | "run_started"
  | "node_started"
  | "node_finished"
  | "tool_called"
  | "token"
  | "message"
  | "report_ready"
  | "gap_ready"
  | "proposals_ready"
  | "critique"
  | "review_required"
  | "run_completed"
  | "run_failed";

export interface Event {
  id: number;
  session_id: string;
  run_id: string;
  type: EventType;
  node: string;
  data: Record<string, unknown>;
  at: string;
}

export interface Health {
  status: string;
  database: boolean;
}

export interface ApiError {
  detail: string;
}

const RUN_FAILED_MESSAGES: Record<string, string> = {
  budget_exceeded:
    "Daily LLM demo budget limit reached (budget_exceeded). Switch to Mock Replay Mode to explore the full workflow without API spend.",
  model_error:
    "The upstream language model provider returned an error (model_error). Send a message or retry in a moment.",
  invalid_model_output:
    "A subagent returned a malformed structured output after retries (invalid_model_output). Send a message to run the step again.",
  internal_error:
    "An unexpected server error interrupted the run (internal_error). Please retry or resume your session.",
};

export function formatRunFailedError(code: string): string {
  const key = code.trim();
  return (
    RUN_FAILED_MESSAGES[key] ??
    `The run stopped with an error (${key || "unknown_error"}). Send a message to retry.`
  );
}

// ---------------------------------------------------------------- Route helpers & Mock state

const SESSION_PATH_RE = /^\/s\/([^/]+)\/?$/;

export function parseSessionIdFromPath(pathname: string): string | null {
  const match = SESSION_PATH_RE.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

let mockModeOverride: boolean | null = null;
let mockSnapshot: SessionSnapshot = createInitialMockSnapshot();
const mockListeners = new Set<(event: Event) => void>();

export function isMockMode(): boolean {
  if (mockModeOverride !== null) {
    return mockModeOverride;
  }
  return import.meta.env.VITE_MOCK === "1" || import.meta.env.VITE_MOCK === "true";
}

export function setMockMode(enabled: boolean): void {
  mockModeOverride = enabled;
}

export function activateDemoSessionSnapshot(): void {
  mockSnapshot = createDemoReviewMockSnapshot("demo");
}

export function getMockSnapshotState(): SessionSnapshot {
  return mockSnapshot;
}

export function updateMockSnapshotState(updater: (prev: SessionSnapshot) => SessionSnapshot): void {
  mockSnapshot = updater(mockSnapshot);
}

export function subscribeMockEvents(cb: (event: Event) => void): () => void {
  mockListeners.add(cb);
  return () => {
    mockListeners.delete(cb);
  };
}

export function emitMockEvent(event: Event): void {
  mockListeners.forEach((cb) => cb(event));
}

export function formatProfileAsMarkdown(profile: CandidateProfile, targetTitle?: string): string {
  const expBlocks = profile.experience
    .map((exp) => {
      const bullets = exp.bullets.map((b) => `- ${b.text}`).join("\n");
      return `### ${exp.title} — ${exp.organization} (${exp.location})\n*${exp.start} – ${exp.end}*\n${bullets}`;
    })
    .join("\n\n");

  const eduBlocks = profile.education
    .map(
      (e) => `- **${e.degree}**, ${e.institution} (${e.year})${e.details ? ` — ${e.details}` : ""}`,
    )
    .join("\n");

  return `# ${profile.name}
**${targetTitle || profile.headline}**
${profile.contact.join(" · ")}

## Summary
${profile.summary}

## Experience
${expBlocks}

## Education
${eduBlocks}

## Skills
${profile.skills.join(", ")}
`;
}

function buildMockExportJson(snapshot: SessionSnapshot): ExportJson {
  // Proposals without an explicit decision (or with action === "reject") count as rejected.
  const resolveText = (proposalId: string, fallback: string): string => {
    const dec = snapshot.decisions[proposalId];
    const prop = snapshot.proposals.find((item) => item.id === proposalId);
    if (!dec || !prop || dec.action === "reject") return fallback;
    if (dec.action === "edit" && dec.text.trim()) return dec.text.trim();
    if (dec.action === "accept") return prop.proposed;
    return fallback;
  };

  const base = MOCK_CANDIDATE_PROFILE;
  const skillsText = resolveText("resume:skills", base.skills.join(", "));
  const skills = skillsText
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const resume: CandidateProfile = {
    ...base,
    summary: resolveText("resume:summary", base.summary),
    skills,
    experience: base.experience.map((exp) => ({
      ...exp,
      bullets: exp.bullets.map((b) => ({
        ...b,
        text: resolveText(`resume:${b.id}`, b.text),
      })),
    })),
  };

  const linkedin: Record<string, string> = {};
  snapshot.proposals
    .filter((p) => p.document === "linkedin")
    .forEach((p) => {
      linkedin[p.target] = resolveText(p.id, p.original);
    });

  return { resume, linkedin };
}

// ---------------------------------------------------------------- HTTP Endpoints

export async function getHealth(): Promise<Health> {
  if (isMockMode()) {
    return { status: "ok", database: true };
  }
  return request<Health>("/api/health");
}

export async function uploadDocument(kind: DocumentKind, file: File): Promise<DocumentCreated> {
  if (isMockMode()) {
    const text = await file.text().catch(() => file.name);
    return createMockDocument(kind, text || `Uploaded ${file.name} (${file.size} bytes)`);
  }
  const formData = new FormData();
  formData.append("kind", kind);
  formData.append("file", file);
  return request<DocumentCreated>("/api/documents", {
    method: "POST",
    formData,
  });
}

export async function submitDocumentText(body: DocumentText): Promise<DocumentCreated> {
  if (isMockMode()) {
    return createMockDocument(body.kind, body.text);
  }
  return request<DocumentCreated>("/api/documents/text", {
    method: "POST",
    body,
  });
}

export async function createSession(body: SessionCreate): Promise<RunAccepted> {
  if (isMockMode()) {
    mockSnapshot = createInitialMockSnapshot(
      body.target.title,
      body.target.company,
      body.target.job_url,
      body.target.job_text,
      Boolean(body.linkedin_document_id),
    );
    return { session_id: MOCK_SESSION_ID, run_id: MOCK_RUN_ID };
  }
  return request<RunAccepted>("/api/sessions", {
    method: "POST",
    body,
  });
}

export async function getSession(
  sessionId: string,
  signal?: AbortSignal,
): Promise<SessionSnapshot> {
  if (isMockMode()) {
    if (signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    if (sessionId === "missing" || sessionId === "not-found") {
      throw new HttpError(404, "session_not_found");
    }
    if (sessionId === "demo" && mockSnapshot.session_id !== "demo") {
      mockSnapshot = createDemoReviewMockSnapshot("demo");
    }
    return { ...mockSnapshot, session_id: sessionId };
  }
  return request<SessionSnapshot>(`/api/sessions/${encodeURIComponent(sessionId)}`, { signal });
}

export async function sendMessage(sessionId: string, body: MessageCreate): Promise<RunAccepted> {
  if (isMockMode()) {
    const userMsg: ChatMessage = {
      id: `msg-user-${Date.now()}`,
      role: "user",
      content: body.content,
    };
    const replyContent =
      "I've updated the proposal grounding based on your note and verified that every metric traces back to your Solstice Telemetry and Northwind roles. You can export the final ATS-ready DOCX or Markdown anytime from the Export tab.";
    const assistantMsg: ChatMessage = {
      id: `msg-asst-${Date.now() + 1}`,
      role: "assistant",
      content: replyContent,
    };
    mockSnapshot = {
      ...mockSnapshot,
      messages: [...mockSnapshot.messages, userMsg, assistantMsg],
      cost_usd: Number((mockSnapshot.cost_usd + 0.0014).toFixed(4)),
    };
    setTimeout(() => {
      emitMockEvent({
        id: ++mockSnapshot.last_event_id,
        session_id: sessionId,
        run_id: MOCK_RUN_ID,
        type: "token",
        node: "concierge",
        data: { text: "I've updated the proposal grounding..." },
        at: new Date().toISOString(),
      });
      emitMockEvent({
        id: ++mockSnapshot.last_event_id,
        session_id: sessionId,
        run_id: MOCK_RUN_ID,
        type: "message",
        node: "concierge",
        data: assistantMsg as unknown as Record<string, unknown>,
        at: new Date().toISOString(),
      });
      emitMockEvent({
        id: ++mockSnapshot.last_event_id,
        session_id: sessionId,
        run_id: MOCK_RUN_ID,
        type: "run_completed",
        node: "concierge",
        data: { status: mockSnapshot.status },
        at: new Date().toISOString(),
      });
    }, 120);
    return { session_id: sessionId, run_id: MOCK_RUN_ID };
  }
  return request<RunAccepted>(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: "POST",
    body,
  });
}

export async function submitReview(sessionId: string, body: ReviewSubmit): Promise<RunAccepted> {
  if (isMockMode()) {
    if (mockSnapshot.status !== "review") {
      throw new HttpError(409, "no_review_pending");
    }
    const acceptedCount = Object.values(body.decisions).filter(
      (d) => d.action === "accept" || d.action === "edit",
    ).length;
    const doneMsg: ChatMessage = {
      id: `msg-review-done-${Date.now()}`,
      role: "assistant",
      content: `Review complete: applied **${acceptedCount}** approved rewrites across your resume and LinkedIn profile. Your ATS-ready single-column DOCX, Markdown, and print-to-PDF views are now unlocked in the **Export & Print** panel.`,
    };
    mockSnapshot = {
      ...mockSnapshot,
      status: "idle",
      reports: MOCK_REPORTS,
      gap: MOCK_GAP_REPORT,
      proposals: MOCK_PROPOSALS,
      decisions: body.decisions,
      reviewed: true,
      messages: [...mockSnapshot.messages, doneMsg],
      cost_usd: 0.0186,
    };
    setTimeout(() => {
      emitMockEvent({
        id: ++mockSnapshot.last_event_id,
        session_id: sessionId,
        run_id: MOCK_RUN_ID,
        type: "node_started",
        node: "finalize",
        data: { label: "Applying decisions to candidate profile & LinkedIn blocks" },
        at: new Date().toISOString(),
      });
      emitMockEvent({
        id: ++mockSnapshot.last_event_id,
        session_id: sessionId,
        run_id: MOCK_RUN_ID,
        type: "node_finished",
        node: "finalize",
        data: { label: `Applied ${acceptedCount} rewrites`, seconds: 0.4 },
        at: new Date().toISOString(),
      });
      emitMockEvent({
        id: ++mockSnapshot.last_event_id,
        session_id: sessionId,
        run_id: MOCK_RUN_ID,
        type: "message",
        node: "concierge",
        data: doneMsg as unknown as Record<string, unknown>,
        at: new Date().toISOString(),
      });
      emitMockEvent({
        id: ++mockSnapshot.last_event_id,
        session_id: sessionId,
        run_id: MOCK_RUN_ID,
        type: "run_completed",
        node: "concierge",
        data: { status: "idle" },
        at: new Date().toISOString(),
      });
    }, 80);
    return { session_id: sessionId, run_id: MOCK_RUN_ID };
  }
  return request<RunAccepted>(`/api/sessions/${encodeURIComponent(sessionId)}/review`, {
    method: "POST",
    body,
  });
}

export async function resumeSession(sessionId: string): Promise<RunAccepted> {
  if (isMockMode()) {
    mockSnapshot = { ...mockSnapshot, status: "running" };
    return { session_id: sessionId, run_id: MOCK_RUN_ID };
  }
  return request<RunAccepted>(`/api/sessions/${encodeURIComponent(sessionId)}/resume`, {
    method: "POST",
  });
}

export async function getExportJson(sessionId: string, signal?: AbortSignal): Promise<ExportJson> {
  if (isMockMode()) {
    if (signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    if (!mockSnapshot.reviewed) {
      throw new HttpError(409, "not_reviewed");
    }
    return buildMockExportJson(mockSnapshot);
  }
  return request<ExportJson>(`/api/sessions/${encodeURIComponent(sessionId)}/export?format=json`, {
    method: "GET",
    signal,
  });
}

export function getExportHtmlUrl(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/export?format=html`;
}

export async function downloadExport(sessionId: string, format: "docx" | "md"): Promise<Blob> {
  if (isMockMode()) {
    if (!mockSnapshot.reviewed) {
      throw new HttpError(409, "not_reviewed");
    }
    const exported = buildMockExportJson(mockSnapshot);
    const md = formatProfileAsMarkdown(exported.resume, mockSnapshot.target.title);
    const mime =
      format === "md"
        ? "text/markdown;charset=utf-8"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    return new Blob([md], { type: mime });
  }
  return request<Blob>(
    `/api/sessions/${encodeURIComponent(sessionId)}/export?format=${encodeURIComponent(format)}`,
    {
      method: "GET",
      responseType: "blob",
    },
  );
}
