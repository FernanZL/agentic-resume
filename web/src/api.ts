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

export type ExperienceKind = "employment" | "project" | "volunteer" | "other" | "unclassified";

export interface Experience {
  id: string;
  title: string;
  organization: string;
  kind?: ExperienceKind;
  source_section?: string;
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
  notes?: string;
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

export type LinkedInAuditBasis = "profile" | "public" | "resume_only";

export interface LinkedInAudit {
  summary: string;
  basis?: LinkedInAuditBasis;
  sources?: Source[];
  limitations?: string[];
  headline_issues: string[];
  about_issues: string[];
  experience_gaps: string[];
  inconsistencies: string[];
  steps?: string[];
}

export interface Report {
  kind: ReportKind;
  job?: JobAnalysis | null;
  company?: CompanyBrief | null;
  market?: MarketBrief | null;
  linkedin?: LinkedInAudit | null;
  error?: string;
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
  evidence_refs?: string[];
}

export type Action = "accept" | "reject" | "edit";

export interface Decision {
  action: Action;
  text: string;
}

export interface ReviewDraftEntry {
  action: Action | null;
  text: string;
  proposedAtDraft: string;
  issues?: string[];
  stale?: boolean;
}

export interface ReconcileDraftOptions {
  preserveEditsOnConflict?: boolean;
  additions?: Proposal[];
}

export function reconcileReviewDrafts(
  proposals: Proposal[],
  serverDecisions: Record<string, Decision>,
  prevDrafts: Record<string, ReviewDraftEntry>,
  options?: ReconcileDraftOptions,
): Record<string, ReviewDraftEntry> {
  const next: Record<string, ReviewDraftEntry> = {};
  const mergedProposals =
    options?.additions && options.additions.length > 0
      ? [
          ...proposals,
          ...options.additions.filter((add) => !proposals.some((p) => p.id === add.id)),
        ]
      : proposals;

  mergedProposals.forEach((p) => {
    const existingDraft = prevDrafts[p.id];
    if (existingDraft && existingDraft.proposedAtDraft === p.proposed) {
      next[p.id] = existingDraft;
      return;
    }
    if (
      options?.preserveEditsOnConflict &&
      existingDraft &&
      existingDraft.action === "edit" &&
      existingDraft.text.trim()
    ) {
      next[p.id] = {
        ...existingDraft,
        stale: existingDraft.proposedAtDraft !== p.proposed || existingDraft.stale,
      };
      return;
    }
    const serverDec = serverDecisions[p.id];
    if (serverDec) {
      next[p.id] = {
        action: serverDec.action,
        text: serverDec.action === "edit" && serverDec.text ? serverDec.text : p.proposed,
        proposedAtDraft: p.proposed,
        stale: Boolean(
          existingDraft &&
          existingDraft.action !== null &&
          existingDraft.proposedAtDraft !== p.proposed,
        ),
      };
      return;
    }
    next[p.id] = {
      action: null,
      text: p.proposed,
      proposedAtDraft: p.proposed,
      stale: Boolean(
        existingDraft &&
        existingDraft.action !== null &&
        existingDraft.proposedAtDraft !== p.proposed,
      ),
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

export interface AskRequest {
  content: string;
  proposal_id?: string;
  draft_text?: string;
}

export interface DraftSuggestion {
  proposal_id: string;
  text: string;
  issues: string[];
  proposed_at_request: string;
  proposal?: Proposal | null;
}

export interface AskResponse {
  message: ChatMessage;
  suggestion: DraftSuggestion | null;
  revision?: string;
}

export interface ReanalyzeRequest {
  target: TargetJob;
  confirmed: true;
}

export interface ReviewSubmit {
  decisions: Record<string, Decision>;
  additions?: Proposal[];
  expected_revision?: string;
}

export interface SessionSnapshot {
  session_id: string;
  status: SessionStatus;
  created_at: string;
  target: TargetJob;
  profile?: CandidateProfile | null;
  revision?: string;
  linkedin_guidance?: Record<string, LinkedInGuidanceItem>;
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

export interface LinkedInGuidanceItem {
  section: string;
  field: string;
  instructions: string;
  character_limit: number | null;
  verified: boolean;
  source_url: string;
  version?: string;
  status?: string;
}

export interface ExportJson {
  resume: CandidateProfile;
  linkedin: Record<string, string>;
  linkedin_guidance?: Record<string, LinkedInGuidanceItem>;
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
    "The upstream language model provider returned an error (model_error). Use Change target / Run fresh analysis to retry, or ask about your saved results.",
  invalid_model_output:
    "A subagent returned a malformed structured output after retries (invalid_model_output). Use Change target / Run fresh analysis to retry after checking your inputs.",
  internal_error:
    "An unexpected server error interrupted the run (internal_error). Please retry or resume your session.",
};

export function formatRunFailedError(code: string): string {
  const key = code.trim();
  return (
    RUN_FAILED_MESSAGES[key] ??
    `The run stopped with an error (${key || "unknown_error"}). Use Change target / Run fresh analysis to retry.`
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

export const SECTION_HEADINGS: Record<ExperienceKind, string> = {
  employment: "Experience",
  project: "Projects",
  volunteer: "Volunteering",
  other: "Additional Experience",
  unclassified: "Experience",
};

export function sectionHeadingForRole(role: Experience): string {
  const explicit = role.source_section?.trim();
  if (explicit) return explicit;
  const kind: ExperienceKind = role.kind ?? "unclassified";
  return SECTION_HEADINGS[kind] ?? "Experience";
}

export function roleSections(profile: CandidateProfile): Array<[string, Experience[]]> {
  const grouped: Array<[string, Experience[]]> = [];
  for (const role of profile.experience) {
    const heading = sectionHeadingForRole(role);
    const last = grouped[grouped.length - 1];
    if (last && last[0] === heading) {
      last[1].push(role);
    } else {
      grouped.push([heading, [role]]);
    }
  }
  return grouped;
}

const LINKEDIN_GUIDANCE_VERSION = "2026-04-advisory";

export function getLinkedInGuidance(
  target: string,
  profile?: CandidateProfile | null,
  serverGuidance?: LinkedInGuidanceItem,
): LinkedInGuidanceItem {
  if (serverGuidance) {
    return serverGuidance;
  }
  const key = target.replace(/^linkedin:/, "");
  if (key === "headline") {
    return {
      section: "Intro card",
      field: "Headline",
      instructions:
        "Open your LinkedIn profile, click the pencil icon in the top intro card, and paste this into Headline.",
      character_limit: 220,
      verified: false,
      source_url: "",
      version: LINKEDIN_GUIDANCE_VERSION,
      status: "unverified_advisory",
    };
  }
  if (key === "about" || key === "summary") {
    return {
      section: "About",
      field: "About summary",
      instructions:
        "In the About section, click the pencil icon and paste this text. Keep paragraphs separated with blank lines for readability.",
      character_limit: 2600,
      verified: false,
      source_url: "",
      version: LINKEDIN_GUIDANCE_VERSION,
      status: "unverified_advisory",
    };
  }
  if (key === "skills") {
    return {
      section: "Skills",
      field: "Skills list",
      instructions:
        "In the Skills section, add or reorder skills individually rather than pasting the comma-separated list into one field.",
      character_limit: null,
      verified: false,
      source_url: "",
      version: LINKEDIN_GUIDANCE_VERSION,
      status: "unverified_advisory",
    };
  }

  let matchedRole: Experience | undefined;
  if (profile && /^exp\d+$/.test(key)) {
    const idx = Number.parseInt(key.slice(3), 10);
    matchedRole = profile.experience.find((r) => r.id === key) ?? profile.experience[idx];
  }

  if (matchedRole) {
    const label = [matchedRole.title, matchedRole.organization].filter(Boolean).join(" — ");
    const isProject = matchedRole.kind === "project";
    const section = isProject
      ? `Projects · ${matchedRole.title}`
      : `Experience · ${label || matchedRole.title}`;
    const field = isProject ? "Projects description" : "Description";
    return {
      section,
      field,
      instructions: isProject
        ? "Open the Projects section on your LinkedIn profile, edit or add this project entry, and paste this text into Description only."
        : "Edit the matching Experience entry on your LinkedIn profile and paste this into Description only. Keep Title, Company, Location, and Dates in their separate fields.",
      character_limit: 2000,
      verified: false,
      source_url: "https://www.linkedin.com/help/linkedin",
      version: LINKEDIN_GUIDANCE_VERSION,
      status: "advisory_unverified",
    };
  }

  if (/^li(\d+)$/.test(key)) {
    const idx = Number.parseInt(key.slice(2), 10);
    return {
      section: "Experience",
      field: `LinkedIn role ${idx + 1} · Description`,
      instructions:
        "Edit the matching Experience entry on your LinkedIn profile and paste this into Description only. Keep Title, Company, Location, and Dates in their separate fields.",
      character_limit: 2000,
      verified: false,
      source_url: "https://www.linkedin.com/help/linkedin",
      version: LINKEDIN_GUIDANCE_VERSION,
      status: "advisory_unverified",
    };
  }

  return {
    section: "Profile",
    field: key,
    instructions: "Paste this into the matching LinkedIn profile section.",
    character_limit: null,
    verified: false,
    source_url: "",
    version: LINKEDIN_GUIDANCE_VERSION,
    status: "unverified_advisory",
  };
}

export function getLinkedInCopyIssues(
  target: string,
  text: string,
  profile?: CandidateProfile | null,
  serverGuidance?: LinkedInGuidanceItem,
): string[] {
  const g = getLinkedInGuidance(target, profile, serverGuidance);
  const issues: string[] = [];
  if (g.character_limit !== null && text.length > g.character_limit) {
    issues.push(
      `Length is ${text.length} characters, above the ${g.character_limit}-character advisory cap for ${g.field}.`,
    );
  }
  if (/\[[^\]]+\]/.test(text)) {
    issues.push(
      "Contains a bracketed placeholder (e.g. [X]); replace or confirm before publishing.",
    );
  }
  return issues;
}

function stripLinkedInDescriptionHeader(text: string): string {
  const lines = text
    .trim()
    .split("\n")
    .map((ln) => ln.trim())
    .filter(Boolean);
  if (lines.length > 1 && lines[0]?.includes("|")) {
    return lines.slice(1).join("\n");
  }
  return lines.join("\n");
}

export function formatProfileAsMarkdown(profile: CandidateProfile, _targetTitle?: string): string {
  // Keep the old call signature; only the reviewed headline is rendered.
  void _targetTitle;
  const lines: string[] = [`# ${profile.name || "Resume"}`];
  if (profile.headline) {
    lines.push(`**${profile.headline}**`);
  }
  if (profile.contact.length > 0) {
    lines.push(profile.contact.join(" · "));
  }
  lines.push("");

  if (profile.summary) {
    lines.push("## Summary", profile.summary, "");
  }

  for (const [heading, roles] of roleSections(profile)) {
    lines.push(`## ${heading}`);
    for (const r of roles) {
      const whereParts = [r.organization, r.location].filter(Boolean).join(", ");
      const dates = [r.start, r.end].filter(Boolean).join(" – ");
      const titleLine = whereParts ? `### ${r.title} — ${whereParts}` : `### ${r.title}`;
      lines.push(titleLine);
      if (dates) {
        lines.push(`*${dates}*`);
      }
      for (const b of r.bullets) {
        lines.push(`- ${b.text}`);
      }
      lines.push("");
    }
  }

  if (profile.education.length > 0) {
    lines.push("## Education");
    for (const e of profile.education) {
      const year = e.year ? ` (${e.year})` : "";
      const details = e.details ? ` — ${e.details}` : "";
      lines.push(`- **${e.degree}**, ${e.institution}${year}${details}`);
    }
    lines.push("");
  }

  if (profile.skills.length > 0) {
    lines.push("## Skills", profile.skills.join(", "), "");
  }
  if (profile.certifications && profile.certifications.length > 0) {
    lines.push("## Certifications", ...profile.certifications.map((c) => `- ${c}`), "");
  }
  if (profile.languages && profile.languages.length > 0) {
    lines.push("## Languages", ...profile.languages.map((lang) => `- ${lang}`), "");
  }
  if (profile.other && profile.other.length > 0) {
    lines.push("## Other", ...profile.other.map((item) => `- ${item}`), "");
  }

  return `${lines.join("\n").trim()}\n`;
}

function splitListText(target: string, text: string): string[] {
  const parts = target === "skills" ? text.split(/[,\n•;]/) : text.split(/\n/);
  return parts.map((s) => s.replace(/^[-•\s]+/, "").trim()).filter(Boolean);
}

function buildMockExportJson(snapshot: SessionSnapshot): ExportJson {
  // Proposals without an explicit decision (or with action === "reject") count as rejected.
  const baseSource = snapshot.profile ?? MOCK_CANDIDATE_PROFILE;
  const resume: CandidateProfile = {
    ...baseSource,
    contact: [...baseSource.contact],
    skills: [...baseSource.skills],
    certifications: [...(baseSource.certifications ?? [])],
    languages: [...(baseSource.languages ?? [])],
    other: [...(baseSource.other ?? [])],
    experience: baseSource.experience.map((exp) => ({
      ...exp,
      bullets: exp.bullets.map((b) => ({ ...b })),
    })),
    education: baseSource.education.map((edu) => ({ ...edu })),
  };

  const chosenText = (p: Proposal): string | null => {
    const dec = snapshot.decisions[p.id];
    if (!dec || dec.action === "reject") return null;
    if (dec.action === "edit") return dec.text.trim() || p.proposed;
    if (dec.action === "accept") return p.proposed;
    return null;
  };

  for (const p of snapshot.proposals) {
    if (p.document !== "resume") continue;
    const text = chosenText(p);
    if (text === null) continue;

    if (p.target === "headline" || p.target === "summary") {
      resume[p.target] = text;
    } else if (
      p.target === "skills" ||
      p.target === "certifications" ||
      p.target === "languages" ||
      p.target === "other"
    ) {
      resume[p.target] = splitListText(p.target, text);
    } else if (p.target.startsWith("new:")) {
      const roleId = p.target.split(":", 2)[1];
      const role = resume.experience.find((r) => r.id === roleId);
      if (role) {
        role.bullets.push({ id: `${role.id}.b${role.bullets.length}`, text });
      }
    } else if (p.target.includes(".")) {
      const [ownerId, field] = p.target.split(".", 2);
      const role = resume.experience.find((r) => r.id === ownerId);
      if (role && field) {
        if (
          field === "title" ||
          field === "organization" ||
          field === "location" ||
          field === "start" ||
          field === "end" ||
          field === "source_section"
        ) {
          role[field] = text;
        } else {
          const b = role.bullets.find((item) => item.id === p.target);
          if (b) b.text = text;
        }
      }
      const eduMatch = ownerId ? /^edu(\d+)$/.exec(ownerId) : null;
      const eduIdx = eduMatch?.[1] ? Number.parseInt(eduMatch[1], 10) : -1;
      const edu = eduIdx >= 0 ? resume.education[eduIdx] : undefined;
      if (
        edu &&
        field &&
        (field === "institution" || field === "degree" || field === "year" || field === "details")
      ) {
        edu[field] = text;
      }
    }
  }

  const linkedin: Record<string, string> = {
    headline: resume.headline,
    about: resume.summary,
    skills: resume.skills.join(", "),
  };
  for (const role of resume.experience) {
    const body = role.bullets.map((b) => `• ${b.text}`).join("\n");
    if (body) {
      linkedin[role.id] = body;
    }
  }

  for (const p of snapshot.proposals) {
    if (p.document !== "linkedin") continue;
    const text = chosenText(p);
    if (text === null) continue;
    if (p.target === "summary") {
      linkedin.about = text;
    } else if (/^(exp|li)\d+$/.test(p.target)) {
      linkedin[p.target] = stripLinkedInDescriptionHeader(text);
    } else {
      linkedin[p.target] = text;
    }
  }

  const linkedin_guidance: Record<string, LinkedInGuidanceItem> = {};
  for (const key of Object.keys(linkedin)) {
    linkedin_guidance[key] = getLinkedInGuidance(key, resume);
  }
  for (const p of snapshot.proposals) {
    if (p.document === "linkedin" && !linkedin_guidance[p.target]) {
      linkedin_guidance[p.target] = getLinkedInGuidance(p.target, resume);
    }
  }

  return { resume, linkedin, linkedin_guidance };
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

export async function askSession(sessionId: string, body: AskRequest): Promise<AskResponse> {
  if (isMockMode()) {
    if (mockSnapshot.status === "running") {
      throw new HttpError(409, "run_active");
    }
    const userMsg: ChatMessage = {
      id: `msg-ask-user-${Date.now()}`,
      role: "user",
      content: body.content,
    };
    const matchedProposal = body.proposal_id
      ? mockSnapshot.proposals.find((p) => p.id === body.proposal_id)
      : mockSnapshot.proposals.find(
          (p) =>
            body.content.toLowerCase().includes(p.id.toLowerCase()) ||
            body.content.toLowerCase().includes(p.target.toLowerCase()),
        );

    const wantsRewrite =
      Boolean(body.proposal_id) ||
      /\b(rewrite|shorten|edit|tighten|adjust|revise|suggest|concise|change|update|add)\b/i.test(
        body.content,
      );

    let suggestion: DraftSuggestion | null = null;
    let replyContent =
      "Every proposed rewrite stays grounded in your original resume. You can accept, edit, or reject each card in the Review panel, or click **Ask in chat** on any proposal to draft a scoped revision.";

    const profile = mockSnapshot.profile ?? MOCK_CANDIDATE_PROFILE;
    const asksNewField =
      !matchedProposal &&
      wantsRewrite &&
      /\b(certification|certifications|education|edu0|languages|other|degree|institution)\b/i.test(
        body.content,
      );

    if (asksNewField) {
      const isEdu = /\b(education|edu0|degree|institution)\b/i.test(body.content);
      const target = isEdu ? "edu0.details" : "certifications";
      const proposalId = `resume:${target}`;
      const original = isEdu
        ? (profile.education[0]?.details ?? "")
        : (profile.certifications ?? []).join("\n");
      const draftedText = isEdu
        ? "Focus: Distributed Systems & Compilers (GPA 3.9)"
        : [...(profile.certifications ?? []), "CKA — Certified Kubernetes Administrator"].join(
            "\n",
          );
      const newProposal: Proposal = {
        id: proposalId,
        document: "resume",
        target,
        original,
        proposed: draftedText,
        rationale: "User-requested update via advisory assistant.",
        keywords: [],
        placeholders: [],
        issues: [],
        status: "ok",
        evidence_refs: [target],
      };
      suggestion = {
        proposal_id: proposalId,
        text: draftedText,
        issues: [],
        proposed_at_request: draftedText,
        proposal: newProposal,
      };
      replyContent = `I created a new staged proposal \`${proposalId}\` for **${target}**. Click **Load into Edit** below to add it to your review list for explicit approval.`;
    } else {
      const targetProposal =
        matchedProposal ?? (wantsRewrite ? mockSnapshot.proposals[0] : undefined);
      if (targetProposal && wantsRewrite) {
        const issues: string[] = [];
        let draftedText = targetProposal.proposed;
        if (/shorten|concise|tighten/i.test(body.content)) {
          draftedText = targetProposal.proposed.split(".")[0]?.trim()
            ? `${targetProposal.proposed.split(".")[0].trim()}.`
            : targetProposal.proposed;
        } else {
          draftedText = `${targetProposal.proposed} (Tailored per your note.)`;
        }
        if (/\[[^\]]+\]/.test(draftedText)) {
          issues.push("Contains a bracketed placeholder; replace before final export.");
        }
        suggestion = {
          proposal_id: targetProposal.id,
          text: draftedText,
          issues,
          proposed_at_request: targetProposal.proposed,
        };
        replyContent = `Here is a draft revision for \`${targetProposal.id}\` based on your request. Review it below and click **Load into Edit** if you want to place it into that proposal's edit buffer—your other review decisions remain untouched.`;
      } else if (targetProposal) {
        replyContent = `Proposal \`${targetProposal.id}\` (${targetProposal.target}) rewrites the original text because: ${targetProposal.rationale}`;
      }
    }

    const assistantMsg: ChatMessage = {
      id: `msg-ask-asst-${Date.now() + 1}`,
      role: "assistant",
      content: replyContent,
    };
    mockSnapshot = {
      ...mockSnapshot,
      messages: [...mockSnapshot.messages, userMsg, assistantMsg],
    };
    return {
      message: assistantMsg,
      suggestion,
      revision: mockSnapshot.revision ?? "rev-demo-1",
    };
  }
  return request<AskResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/ask`, {
    method: "POST",
    body,
  });
}

function mergeProposalAdditions(existing: Proposal[], additions?: Proposal[]): Proposal[] {
  if (!additions || additions.length === 0) return existing;
  const byId = new Set(existing.map((p) => p.id));
  const extra = additions.filter((p) => !byId.has(p.id));
  return [...existing, ...extra];
}

export async function amendSession(
  sessionId: string,
  body: ReviewSubmit,
): Promise<SessionSnapshot> {
  if (isMockMode()) {
    if (mockSnapshot.status === "running") {
      throw new HttpError(409, "run_active");
    }
    if (!mockSnapshot.reviewed || mockSnapshot.status !== "idle") {
      throw new HttpError(409, "not_amendable");
    }
    if (
      !body.expected_revision ||
      (mockSnapshot.revision && body.expected_revision !== mockSnapshot.revision)
    ) {
      throw new HttpError(409, "stale_review");
    }
    const mergedProposals = mergeProposalAdditions(mockSnapshot.proposals, body.additions);
    const updatedDecisions = {
      ...mockSnapshot.decisions,
      ...body.decisions,
    };
    const amendMsg: ChatMessage = {
      id: `msg-amend-${Date.now()}`,
      role: "assistant",
      content:
        "Applied your updated review decisions and refreshed your export-ready resume and LinkedIn copy.",
    };
    mockSnapshot = {
      ...mockSnapshot,
      revision: `rev-amended-${Date.now()}`,
      proposals: mergedProposals,
      decisions: updatedDecisions,
      messages: [...mockSnapshot.messages, amendMsg],
    };
    return { ...mockSnapshot, session_id: sessionId };
  }
  return request<SessionSnapshot>(`/api/sessions/${encodeURIComponent(sessionId)}/amend`, {
    method: "POST",
    body,
  });
}

export async function reanalyzeSession(
  sessionId: string,
  body: ReanalyzeRequest,
): Promise<RunAccepted> {
  if (isMockMode()) {
    if (mockSnapshot.status === "running") {
      throw new HttpError(409, "run_active");
    }
    if (mockSnapshot.status === "review") {
      throw new HttpError(409, "review_pending");
    }
    const reanalyzeMsg: ChatMessage = {
      id: `msg-reanalyze-${Date.now()}`,
      role: "assistant",
      content: `Starting a fresh analysis for **${body.target.title}**${body.target.company ? ` at **${body.target.company}**` : ""}. Previous reports, gap analysis, and rewrite decisions have been cleared.`,
    };
    mockSnapshot = {
      ...mockSnapshot,
      status: "review",
      revision: `rev-reanalyzed-${Date.now()}`,
      target: body.target,
      reports: MOCK_REPORTS,
      gap: MOCK_GAP_REPORT,
      proposals: MOCK_PROPOSALS,
      decisions: {},
      reviewed: false,
      messages: [...mockSnapshot.messages, reanalyzeMsg],
    };
    return { session_id: sessionId, run_id: MOCK_RUN_ID };
  }
  return request<RunAccepted>(`/api/sessions/${encodeURIComponent(sessionId)}/reanalyze`, {
    method: "POST",
    body,
  });
}

export async function submitReview(sessionId: string, body: ReviewSubmit): Promise<RunAccepted> {
  if (isMockMode()) {
    if (mockSnapshot.status !== "review") {
      throw new HttpError(409, "no_review_pending");
    }
    if (
      body.expected_revision &&
      mockSnapshot.revision &&
      body.expected_revision !== mockSnapshot.revision
    ) {
      throw new HttpError(409, "stale_review");
    }
    const mergedProposals = mergeProposalAdditions(MOCK_PROPOSALS, body.additions);
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
      revision: `rev-reviewed-${Date.now()}`,
      reports: MOCK_REPORTS,
      gap: MOCK_GAP_REPORT,
      proposals: mergedProposals,
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
    let md = formatProfileAsMarkdown(exported.resume);
    const linkedinEntries = Object.entries(exported.linkedin);
    if (format === "md" && linkedinEntries.length > 0) {
      const liLines = ["", "# LinkedIn"];
      for (const [key, text] of linkedinEntries) {
        liLines.push("", `## ${key}`, "", text);
      }
      md = `${md.trim()}\n${liLines.join("\n")}\n`;
    }
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
