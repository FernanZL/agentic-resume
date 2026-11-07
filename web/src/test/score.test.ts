import { describe, expect, it } from "vitest";
import type { Event, EventType } from "../api";
import {
  applyEvent,
  axisTicks,
  emptyScore,
  finished,
  formatClock,
  nowPlaying,
  scoreTime,
  staffSeconds,
  staffStatus,
} from "../score";

const T0 = Date.parse("2026-11-07T10:00:00Z");
let id = 0;

function ev(
  type: EventType,
  seconds: number,
  node = "",
  data: Record<string, unknown> = {},
): Event {
  id += 1;
  return {
    id,
    session_id: "s",
    run_id: "r",
    type,
    node,
    data,
    at: new Date(T0 + seconds * 1000).toISOString(),
  };
}

function play(events: Event[]) {
  return events.reduce(applyEvent, emptyScore());
}

describe("the score reducer", () => {
  it("draws parallel researchers, rests skipped ones as tacet, and holds at the fermata", () => {
    const score = play([
      ev("run_started", 0),
      ev("node_started", 1, "concierge"),
      ev("node_finished", 4, "concierge"),
      ev("node_started", 5, "intake"),
      ev("node_finished", 10, "intake"),
      ev("node_started", 10, "job_analyst"),
      ev("node_started", 10, "market_analyst"),
      ev("tool_called", 12, "job_analyst", { tool: "fetch_url", summary: "posting" }),
      ev("node_finished", 40, "job_analyst"),
      ev("node_finished", 30, "market_analyst"),
      ev("node_started", 41, "gap_analysis"),
      ev("node_finished", 50, "gap_analysis"),
      ev("review_required", 60, "review", { proposal_ids: ["resume:summary"] }),
      ev("run_completed", 60, "", { status: "review" }),
    ]);

    expect(staffSeconds(score, "job_analyst", T0)).toBe(30);
    expect(score.staves.job_analyst.notes).toHaveLength(1);
    expect(staffStatus(score, "company_researcher")).toBe("tacet");
    expect(staffStatus(score, "linkedin_auditor")).toBe("tacet");
    expect(staffStatus(score, "review")).toBe("running");
    expect(score.fermata).toBe(T0 + 60_000);
    expect(score.live).toBe(false);
    // The concierge's work in this run is kept when intake starts the analysis.
    expect(score.staves.concierge.segments).toHaveLength(1);
  });

  it("holds the review open when the review node started before the pause", () => {
    const score = play([
      ev("run_started", 0),
      ev("node_started", 0, "intake"),
      ev("node_started", 30, "review"),
      ev("review_required", 30, "review"),
    ]);
    expect(staffStatus(score, "review")).toBe("running");
    expect(finished(score)).toBe(false);
    const done = [
      ev("run_started", 90),
      ev("node_finished", 90, "review"),
      ev("run_completed", 95, "", { status: "idle" }),
    ].reduce(applyEvent, score);
    expect(finished(done)).toBe(true);
  });

  it("removes the review pause from the time axis", () => {
    const score = play([
      ev("run_started", 0),
      ev("node_started", 0, "intake"),
      ev("node_finished", 10, "intake"),
      ev("review_required", 20, "review"),
      ev("run_completed", 20, "", { status: "review" }),
      ev("run_started", 620), // ten minutes later, the user submits
      ev("node_finished", 620, "review"),
    ]);
    expect(scoreTime(score, T0 + 620_000)).toBe(20_000);
    expect(scoreTime(score, T0 + 630_000)).toBe(30_000);
  });

  it("brackets the rewrite rounds in repeat barlines", () => {
    const score = play([
      ev("run_started", 0),
      ev("node_started", 0, "intake"),
      ev("node_started", 50, "resume_writer"),
      ev("node_finished", 60, "resume_writer"),
      ev("node_started", 60, "critic"),
      ev("critique", 70, "critic", { round: 1, flagged_ids: ["resume:exp0.b1"], final: false }),
      ev("node_finished", 70, "critic"),
      ev("node_started", 70, "resume_writer"),
      ev("node_finished", 80, "resume_writer"),
      ev("critique", 90, "critic", { round: 2, flagged_ids: [], final: true }),
    ]);
    expect(score.repeatStart).toBe(T0 + 50_000); // the bracket opens where the writers first played
    expect(score.repeatEnd).toBe(T0 + 90_000);
    expect(score.criticRounds).toBe(2);
    expect(score.staves.resume_writer.segments).toHaveLength(2);
  });

  it("starts over when a new analysis begins", () => {
    const first = play([
      ev("run_started", 0),
      ev("node_started", 0, "intake"),
      ev("node_finished", 5, "intake"),
      ev("node_started", 5, "job_analyst"),
    ]);
    expect(nowPlaying(first)).toBe("Job posting");
    const second = [ev("run_started", 100), ev("node_started", 101, "intake")].reduce(
      applyEvent,
      first,
    );
    expect(second.origin).toBe(T0 + 100_000);
    expect(second.staves.job_analyst.segments).toHaveLength(0);
  });

  it("formats the clock and picks round axis steps", () => {
    expect(formatClock(75)).toBe("1:15");
    expect(axisTicks(160)).toEqual([0, 30, 60, 90, 120, 150]);
  });
});
