/**
 * The score: the live run as one staff per agent on a shared time axis, built from
 * the session's events. Times are stored as wall-clock milliseconds; the review
 * pause is a fermata, so the time it took is removed from the axis.
 */

import type { CandidateProfile, Event, Experience } from "./api";

export const STAVES = [
  { node: "concierge", name: "Assistant", part: "chat" },
  { node: "intake", name: "Intake", part: "reads and screens your documents" },
  { node: "job_analyst", name: "Job posting", part: "researcher" },
  { node: "company_researcher", name: "Company", part: "researcher" },
  { node: "market_analyst", name: "Market", part: "researcher" },
  { node: "linkedin_auditor", name: "LinkedIn audit", part: "researcher" },
  { node: "gap_analysis", name: "Gap analysis", part: "keywords + rubric" },
  { node: "resume_writer", name: "Resume writer", part: "writer" },
  { node: "linkedin_writer", name: "LinkedIn writer", part: "writer" },
  { node: "critic", name: "Critic", part: "fact-checks every rewrite" },
  { node: "review", name: "Your review", part: "you decide" },
] as const;

export type StaffNode = (typeof STAVES)[number]["node"];
export type StaffStatus = "waiting" | "running" | "done" | "tacet";

export const RESEARCHERS: StaffNode[] = [
  "job_analyst",
  "company_researcher",
  "market_analyst",
  "linkedin_auditor",
];
export const REPEATED: StaffNode[] = ["resume_writer", "linkedin_writer", "critic"];

export interface Segment {
  start: number;
  end: number | null;
}

export interface ToolNote {
  at: number;
  tool: string;
  summary: string;
}

export interface Staff {
  node: StaffNode;
  segments: Segment[];
  notes: ToolNote[];
  label: string;
}

export interface ScoreState {
  runStart: number | null; // wall time the current run started
  origin: number | null; // wall time the analysis began (bar 1)
  pauses: Segment[]; // fermatas: wall-clock spans removed from the axis
  staves: Record<StaffNode, Staff>;
  criticRounds: number;
  flaggedIds: string[];
  repeatStart: number | null; // wall time the writers first played, once they played again
  repeatEnd: number | null;
  fermata: number | null; // wall time the run paused for review
  lastAt: number | null;
  live: boolean; // a run is playing right now
}

function emptyStaves(): Record<StaffNode, Staff> {
  const staves = {} as Record<StaffNode, Staff>;
  for (const s of STAVES) staves[s.node] = { node: s.node, segments: [], notes: [], label: "" };
  return staves;
}

export function emptyScore(): ScoreState {
  return {
    runStart: null,
    origin: null,
    pauses: [],
    staves: emptyStaves(),
    criticRounds: 0,
    flaggedIds: [],
    repeatStart: null,
    repeatEnd: null,
    fermata: null,
    lastAt: null,
    live: false,
  };
}

function isStaff(node: string): node is StaffNode {
  return STAVES.some((s) => s.node === node);
}

function withStaff(state: ScoreState, node: StaffNode, update: (s: Staff) => Staff): ScoreState {
  return { ...state, staves: { ...state.staves, [node]: update(state.staves[node]) } };
}

function closeOpen(staff: Staff, at: number): Staff {
  if (!staff.segments.some((seg) => seg.end === null)) return staff;
  return {
    ...staff,
    segments: staff.segments.map((seg) => (seg.end === null ? { ...seg, end: at } : seg)),
  };
}

function closeAll(state: ScoreState, at: number, keep: StaffNode[] = []): ScoreState {
  const staves = { ...state.staves };
  for (const s of STAVES)
    if (!keep.includes(s.node)) staves[s.node] = closeOpen(staves[s.node], at);
  return { ...state, staves };
}

/** A new analysis (intake starting) clears the score, keeping this run's chat. */
function beginAnalysis(state: ScoreState, at: number): ScoreState {
  const origin = state.runStart ?? at;
  const staves = emptyStaves();
  const chat = state.staves.concierge;
  staves.concierge = {
    ...chat,
    segments: chat.segments.filter((seg) => seg.start >= origin),
    notes: chat.notes.filter((n) => n.at >= origin),
  };
  return {
    ...emptyScore(),
    runStart: state.runStart,
    origin,
    staves,
    live: true,
    lastAt: at,
  };
}

function startNode(state: ScoreState, node: StaffNode, at: number, label: string): ScoreState {
  let next = node === "intake" ? beginAnalysis(state, at) : state;
  if (next.origin === null) next = { ...next, origin: next.runStart ?? at };
  if (REPEATED.includes(node) && node !== "critic" && next.criticRounds > 0) {
    // A second pass: the repeat bracket opens where the writers first played.
    if (next.repeatStart === null) {
      const first = next.staves[node].segments[0]?.start ?? at;
      next = { ...next, repeatStart: first };
    }
  }
  return withStaff(next, node, (s) => ({
    ...closeOpen(s, at),
    label: label || s.label,
    segments: [...s.segments, { start: at, end: null }],
  }));
}

/** Fold one event into the score. Unknown or malformed events leave it unchanged. */
export function applyEvent(state: ScoreState, ev: Event): ScoreState {
  const at = Date.parse(ev.at);
  if (Number.isNaN(at)) return state;
  const label = typeof ev.data.label === "string" ? ev.data.label : "";
  let next: ScoreState = { ...state, lastAt: Math.max(state.lastAt ?? at, at) };

  switch (ev.type) {
    case "run_started": {
      const open = next.pauses.find((p) => p.end === null);
      const pauses = open
        ? next.pauses.map((p) => (p.end === null ? { ...p, end: at } : p))
        : next.pauses;
      return { ...next, runStart: at, pauses, live: true };
    }
    case "node_started":
      return isStaff(ev.node) ? startNode(next, ev.node, at, label) : next;
    case "node_finished":
      return isStaff(ev.node)
        ? withStaff(next, ev.node, (s) => ({ ...closeOpen(s, at), label: label || s.label }))
        : next;
    case "tool_called": {
      if (!isStaff(ev.node)) return next;
      const note = {
        at,
        tool: String(ev.data.tool ?? "tool"),
        summary: String(ev.data.summary ?? ""),
      };
      return withStaff(next, ev.node, (s) => ({ ...s, notes: [...s.notes, note] }));
    }
    case "critique": {
      const round = typeof ev.data.round === "number" ? ev.data.round : next.criticRounds + 1;
      const flaggedIds = Array.isArray(ev.data.flagged_ids) ? ev.data.flagged_ids.map(String) : [];
      next = { ...next, criticRounds: round, flaggedIds };
      if (ev.data.final === true && next.repeatStart !== null) next = { ...next, repeatEnd: at };
      return next;
    }
    case "review_required": {
      // Everything stops except the review itself, which holds open: the fermata.
      next = closeAll(next, at, ["review"]);
      next = withStaff(next, "review", (s) =>
        s.segments.some((seg) => seg.end === null)
          ? s
          : { ...s, segments: [...s.segments, { start: at, end: null }] },
      );
      return {
        ...next,
        fermata: at,
        live: false,
        pauses: [...next.pauses, { start: at, end: null }],
      };
    }
    case "run_completed":
    case "run_failed": {
      const reviewOpen = next.staves.review.segments.some((seg) => seg.end === null);
      const closed = closeAll(next, at);
      // A run that paused for review keeps the review staff open: the fermata holds.
      const kept =
        reviewOpen && ev.data.status === "review" ? next.staves.review : closed.staves.review;
      return { ...closed, staves: { ...closed.staves, review: kept }, live: false };
    }
    default:
      return next;
  }
}

/** Milliseconds of score time at a wall time: elapsed since bar 1, fermatas removed. */
export function scoreTime(state: ScoreState, wall: number): number {
  if (state.origin === null) return 0;
  let paused = 0;
  for (const p of state.pauses) {
    const end = p.end ?? Infinity;
    if (wall > p.start) paused += Math.min(wall, end) - p.start;
  }
  return Math.max(0, wall - state.origin - paused);
}

export function staffStatus(state: ScoreState, node: StaffNode): StaffStatus {
  const staff = state.staves[node];
  if (staff.segments.some((seg) => seg.end === null)) return "running";
  if (staff.segments.length) return "done";
  const researchOver = state.staves.gap_analysis.segments.length > 0;
  return RESEARCHERS.includes(node) && researchOver ? "tacet" : "waiting";
}

/** Seconds of work a staff did (its beams' total length on the axis). */
export function staffSeconds(state: ScoreState, node: StaffNode, now: number): number {
  return (
    state.staves[node].segments.reduce((sum, seg) => {
      if (node === "review") return sum;
      return sum + (scoreTime(state, seg.end ?? now) - scoreTime(state, seg.start));
    }, 0) / 1000
  );
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Axis ticks: a round step giving at most eight ticks across the length. */
export function axisTicks(totalSeconds: number): number[] {
  const steps = [5, 10, 15, 30, 60, 120, 300, 600];
  const step = steps.find((s) => totalSeconds / s <= 8) ?? 1200;
  const ticks: number[] = [];
  for (let t = 0; t <= totalSeconds; t += step) ticks.push(t);
  return ticks;
}

/** What is playing now, in words, for the status line and screen readers. */
export function nowPlaying(state: ScoreState): string {
  const running = STAVES.filter((s) => staffStatus(state, s.node) === "running").map((s) => s.name);
  if (!running.length) return "";
  if (running.length > 2) return `${running.length} agents in parallel`;
  return running.join(" and ");
}

/** Whether the analysis has played through to its end (the review is decided). */
export function finished(state: ScoreState): boolean {
  const review = state.staves.review.segments;
  return !state.live && review.length > 0 && review.every((seg) => seg.end !== null);
}

const TOOL_NAMES: Record<string, string> = {
  fetch_url: "fetch",
  web_search: "search",
  screen: "screen",
  revise_proposal: "revise",
};

export function toolName(tool: string): string {
  return TOOL_NAMES[tool] ?? tool.replace(/_/g, " ");
}

function resolveRoleLabel(
  indexOrId: string,
  profile?: CandidateProfile | null,
  fallbackPrefix = "Experience",
): string {
  if (profile) {
    const idx = /^\d+$/.test(indexOrId) ? Number.parseInt(indexOrId, 10) : -1;
    const role: Experience | undefined =
      profile.experience.find((r) => r.id === (idx >= 0 ? `exp${idx}` : indexOrId)) ??
      (idx >= 0 ? profile.experience[idx] : undefined);
    if (role) {
      const parts = [role.title, role.organization].filter(Boolean);
      if (parts.length > 0) {
        return parts.join(" — ");
      }
    }
  }
  const num = /^\d+$/.test(indexOrId) ? Number(indexOrId) + 1 : indexOrId;
  return `${fallbackPrefix} ${num}`;
}

/** A proposal's target in words: actual role/project title or "Experience 1 · bullet 2" rather than "exp0.b1". */
export function targetName(target: string, profile?: CandidateProfile | null): string {
  const cleaned = target.replace(/^(resume|linkedin):/, "");
  const fixed: Record<string, string> = {
    summary: "Summary",
    headline: "Headline",
    skills: "Skills",
    certifications: "Certifications",
    languages: "Languages",
    other: "Other",
    about: "About",
  };
  if (fixed[cleaned]) return fixed[cleaned];

  let m = /^exp(\d+)\.b(\d+)$/.exec(cleaned);
  if (m && m[1] && m[2]) {
    const roleLabel = resolveRoleLabel(m[1], profile, "Experience");
    return `${roleLabel} · bullet ${Number(m[2]) + 1}`;
  }

  m = /^new:exp(\d+)$/.exec(cleaned);
  if (m && m[1]) {
    const roleLabel = resolveRoleLabel(m[1], profile, "Experience");
    return `${roleLabel} · new bullet`;
  }

  m = /^exp(\d+)\.(title|organization|location|start|end|source_section)$/.exec(cleaned);
  if (m && m[1] && m[2]) {
    const roleLabel = resolveRoleLabel(m[1], profile, "Experience");
    const fieldLabel = m[2] === "source_section" ? "section heading" : m[2];
    return `${roleLabel} · ${fieldLabel}`;
  }

  m = /^edu(\d+)\.(institution|degree|year|details)$/.exec(cleaned);
  if (m && m[1] && m[2]) {
    const idx = Number.parseInt(m[1], 10);
    const edu = profile?.education[idx];
    const eduLabel = edu
      ? [edu.degree, edu.institution].filter(Boolean).join(" — ")
      : `Education ${idx + 1}`;
    return `${eduLabel} · ${m[2]}`;
  }

  m = /^li(\d+)$/.exec(cleaned);
  if (m && m[1]) {
    return `LinkedIn role ${Number(m[1]) + 1}`;
  }

  m = /^exp(\d+)$/.exec(cleaned);
  if (m && m[1]) {
    return resolveRoleLabel(m[1], profile, "Experience");
  }

  return target;
}
