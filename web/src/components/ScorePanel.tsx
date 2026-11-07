/**
 * The run as a score: one staff per agent on a shared time axis. Beams are work,
 * noteheads are tool calls, the rewrite rounds sit inside repeat barlines, and the
 * review is a fermata. Choosing a staff opens its part: what it did and its evidence.
 */

import { useEffect, useState } from "react";
import type { GapReport, Proposal, Report } from "../api";
import {
  REPEATED,
  STAVES,
  type ScoreState,
  type StaffNode,
  type StaffStatus,
  axisTicks,
  finished,
  formatClock,
  scoreTime,
  staffSeconds,
  staffStatus,
  targetName,
  toolName,
} from "../score";
import { GapView, ReportView } from "./Reports";

const REPORT_OF: Partial<Record<StaffNode, string>> = {
  job_analyst: "job",
  company_researcher: "company",
  market_analyst: "market",
  linkedin_auditor: "linkedin",
};

const STATUS_WORDS: Record<StaffStatus, string> = {
  waiting: "not started",
  running: "playing now",
  done: "done",
  tacet: "tacet, not needed for this run",
};

/** The current time, ticking while the run plays. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [live]);
  return now;
}

function Fermata({ left }: { left: string }) {
  return (
    <svg className="fermata" style={{ left }} viewBox="0 0 32 18" aria-hidden="true">
      <path d="M2 16 A14 14 0 0 1 30 16" fill="none" stroke="currentColor" strokeWidth="2.4" />
      <circle cx="16" cy="13" r="2.6" fill="currentColor" />
    </svg>
  );
}

function StaffLines() {
  return (
    <svg className="staff-lines" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
      {[4, 12, 20, 28, 36].map((y) => (
        <line key={y} x1="0" x2="100" y1={y} y2={y} vectorEffect="non-scaling-stroke" />
      ))}
    </svg>
  );
}

/** Which noteheads get a visible tool label: those with room since the last label. */
function labelled(positions: number[]): boolean[] {
  let last = -1;
  return positions.map((x) => {
    if (last >= 0 && x - last < 0.07) return false;
    last = x;
    return true;
  });
}

/** At the end of the writers' and critic's staves: a link to the proposals they made. */
function BarLink({
  node,
  proposals,
  flaggedIds,
  onOpenProposal,
}: {
  node: StaffNode;
  proposals: Proposal[];
  flaggedIds: string[];
  onOpenProposal: (id: string) => void;
}) {
  let made: Proposal[] = [];
  let words = "";
  if (node === "resume_writer" || node === "linkedin_writer") {
    const doc = node === "resume_writer" ? "resume" : "linkedin";
    made = proposals.filter((p) => p.document === doc);
    words = `${made.length} ${made.length === 1 ? "proposal" : "proposals"}`;
  } else if (node === "critic") {
    made = proposals.filter((p) => p.status === "flagged" || flaggedIds.includes(p.id));
    words = `${made.length} flagged`;
  }
  if (!made.length) return null;
  return (
    <button type="button" className="bar-link" onClick={() => onOpenProposal(made[0].id)}>
      {words}
    </button>
  );
}

export interface ScorePanelProps {
  score: ScoreState;
  reports: Record<string, Report>;
  gap: GapReport | null;
  proposals: Proposal[];
  selected: StaffNode;
  onSelect: (node: StaffNode) => void;
  onOpenProposal: (id: string) => void;
}

export function ScorePanel({
  score,
  reports,
  gap,
  proposals,
  selected,
  onSelect,
  onOpenProposal,
}: ScorePanelProps) {
  const now = useNow(score.live);
  const end = score.live ? now : (score.lastAt ?? now);
  const totalSeconds = Math.max(scoreTime(score, end) / 1000, 20) * 1.16; // room after the last bar
  const pct = (wall: number) =>
    `${((scoreTime(score, wall) / 1000 / totalSeconds) * 100).toFixed(3)}%`;
  const ticks = axisTicks(totalSeconds);
  const started = score.origin !== null;
  const rounds = score.criticRounds;
  // The repeat closes after the last bar inside it, whichever staff played it last.
  const closeAt =
    score.repeatStart === null
      ? null
      : Math.max(
          score.repeatEnd ?? end,
          ...REPEATED.flatMap((n) => score.staves[n].segments.map((seg) => seg.end ?? end)),
        );

  return (
    <div className="score-wrap">
      <section className="score" aria-label="The run as a score">
        <div className="score-axis" aria-hidden="true">
          <span>Agent</span>
          <div className="ticks">
            {ticks.map((t) => (
              <span key={t} style={{ left: `${(t / totalSeconds) * 100}%` }}>
                {formatClock(t)}
              </span>
            ))}
          </div>
          <span className="axis-time">Time</span>
        </div>

        <ol className={`staves${finished(score) ? " staves-final" : ""}`}>
          {STAVES.map((s) => {
            const staff = score.staves[s.node];
            const status = staffStatus(score, s.node);
            const seconds = staffSeconds(score, s.node, end);
            const repeated = REPEATED.includes(s.node) && score.repeatStart !== null;
            return (
              <li key={s.node} className={`staff staff-${status}`}>
                <button
                  type="button"
                  className="staff-name"
                  aria-pressed={selected === s.node}
                  aria-label={`${s.name}: ${STATUS_WORDS[status]}${seconds ? `, ${formatClock(seconds)}` : ""}`}
                  onClick={() => onSelect(s.node)}
                >
                  <span className="staff-title">{s.name}</span>
                  <span className="staff-part">{s.part}</span>
                </button>
                <div className="staff-lane">
                  <div className="lane-art" aria-hidden="true">
                    <StaffLines />
                    {staff.segments.map((seg, i) =>
                      s.node === "review" ? null : (
                        <span
                          key={i}
                          className={`beam${seg.end === null ? " beam-live" : ""}`}
                          style={{
                            left: pct(seg.start),
                            width: `calc(${pct(seg.end ?? end)} - ${pct(seg.start)})`,
                          }}
                        />
                      ),
                    )}
                    {labelled(
                      staff.notes.map((n) => scoreTime(score, n.at) / 1000 / totalSeconds),
                    ).map((showLabel, i) => {
                      const n = staff.notes[i];
                      return (
                        <span key={i} className="tool-note" style={{ left: pct(n.at) }}>
                          <span className="notehead" />
                          {showLabel ? (
                            <span className="tool-label">{toolName(n.tool)}</span>
                          ) : null}
                        </span>
                      );
                    })}
                    {repeated && score.repeatStart !== null ? (
                      <>
                        <span
                          className="repeat repeat-open"
                          style={{ left: `calc(${pct(score.repeatStart)} - 14px)` }}
                        />
                        <span
                          className="repeat repeat-close"
                          style={{ left: `calc(${pct(closeAt ?? end)} + 14px)` }}
                        />
                        {s.node === "resume_writer" ? (
                          <span
                            className="repeat-count"
                            style={{ left: `calc(${pct(closeAt ?? end)} + 14px)` }}
                          >
                            ×{rounds}
                          </span>
                        ) : null}
                      </>
                    ) : null}
                    {status === "tacet" ? <span className="tacet">tacet</span> : null}
                    {s.node === "review" && score.fermata !== null ? (
                      <Fermata left={pct(score.fermata)} />
                    ) : null}
                  </div>
                </div>
                <span className="staff-time">
                  <span>
                    {seconds ? formatClock(seconds) : status === "running" ? "waits" : "—"}
                  </span>
                  <BarLink
                    node={s.node}
                    proposals={proposals}
                    flaggedIds={score.flaggedIds}
                    onOpenProposal={onOpenProposal}
                  />
                </span>
              </li>
            );
          })}
          {score.live && started ? (
            <li className="playhead-track" aria-hidden="true">
              <span className="playhead" style={{ left: pct(end) }} />
            </li>
          ) : null}
        </ol>
        {!started ? (
          <p className="score-empty">
            The score starts when the assistant sends your documents to the team. Tell it the role
            in the chat, or wait for the first run to begin.
          </p>
        ) : null}
      </section>

      <Part
        node={selected}
        score={score}
        reports={reports}
        gap={gap}
        proposals={proposals}
        end={end}
        onOpenProposal={onOpenProposal}
      />
    </div>
  );
}

function Part({
  node,
  score,
  reports,
  gap,
  proposals,
  end,
  onOpenProposal,
}: {
  node: StaffNode;
  score: ScoreState;
  reports: Record<string, Report>;
  gap: GapReport | null;
  proposals: Proposal[];
  end: number;
  onOpenProposal: (id: string) => void;
}) {
  const meta = STAVES.find((s) => s.node === node) ?? STAVES[0];
  const staff = score.staves[node];
  const status = staffStatus(score, node);
  const reportKind = REPORT_OF[node];
  const report = reportKind ? reports[reportKind] : undefined;
  const written =
    node === "resume_writer" || node === "linkedin_writer"
      ? proposals.filter((p) => p.document === (node === "resume_writer" ? "resume" : "linkedin"))
      : node === "critic"
        ? proposals.filter((p) => p.status === "flagged" || score.flaggedIds.includes(p.id))
        : [];

  return (
    <section className="part" aria-labelledby="part-title">
      <header className="part-head">
        <h2 id="part-title">{meta.name}</h2>
        <span className={`part-status part-status-${status}`}>{STATUS_WORDS[status]}</span>
        <span className="part-time">{formatClock(staffSeconds(score, node, end))}</span>
      </header>
      {staff.label ? <p className="part-label">{staff.label}</p> : null}

      {staff.notes.length ? (
        <ol className="part-notes" aria-label="Tool calls">
          {staff.notes.map((n, i) => (
            <li key={i}>
              <span className="part-note-time">{formatClock(scoreTime(score, n.at) / 1000)}</span>
              <span className="part-note-tool">{n.tool}</span>
              <span className="part-note-summary">{n.summary}</span>
            </li>
          ))}
        </ol>
      ) : null}

      {node === "critic" && score.criticRounds ? (
        <p className="part-label">
          {score.criticRounds} {score.criticRounds === 1 ? "round" : "rounds"} of checks
          {score.criticRounds > 1 ? `, ${score.criticRounds - 1} sent back to the writers` : ""}.
        </p>
      ) : null}

      {reportKind ? (
        report ? (
          <ReportView report={report} />
        ) : status === "tacet" ? (
          <p className="ev-note">Not needed for this run: {tacetReason(node)}</p>
        ) : (
          <p className="ev-note">The report appears here when this researcher finishes.</p>
        )
      ) : null}

      {node === "gap_analysis" ? (
        gap ? (
          <GapView gap={gap} />
        ) : (
          <p className="ev-note">The gap analysis runs after the research.</p>
        )
      ) : null}

      {written.length ? (
        <div className="ev-block">
          <h4>{node === "critic" ? "Flagged proposals" : "Proposals written"}</h4>
          <ul className="code-links">
            {written.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className="code-link"
                  title={p.id}
                  onClick={() => onOpenProposal(p.id)}
                >
                  {p.document === "resume" ? "Resume" : "LinkedIn"} · {targetName(p.target)}
                </button>
                <span>{p.status === "flagged" ? "flagged by the critic" : "checked"}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {node === "concierge" ? (
        <p className="ev-note">
          The assistant talks with you in the chat and hands the work to the team.
        </p>
      ) : null}
      {node === "review" ? (
        <p className="ev-note">
          The run holds here until you decide on every proposal. Nothing is exported without your
          review.
        </p>
      ) : null}
    </section>
  );
}

function tacetReason(node: StaffNode): string {
  if (node === "company_researcher") return "no company was given for this role.";
  if (node === "linkedin_auditor") return "no LinkedIn profile was shared.";
  return "the assistant skipped it.";
}
