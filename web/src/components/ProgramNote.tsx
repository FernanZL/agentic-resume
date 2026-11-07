/**
 * The program note: what the run found, in numbers that each open their evidence,
 * and the one thing the user should do next.
 */

import type { Report, SessionSnapshot } from "../api";
import { type ScoreState, type StaffNode, nowPlaying, staffStatus } from "../score";

const REPORT_ROWS: Array<{ kind: string; node: StaffNode; name: string }> = [
  { kind: "job", node: "job_analyst", name: "Job posting" },
  { kind: "company", node: "company_researcher", name: "Company" },
  { kind: "market", node: "market_analyst", name: "Market" },
  { kind: "linkedin", node: "linkedin_auditor", name: "LinkedIn" },
];

function reportCount(report: Report | undefined): string {
  if (!report) return "";
  if (report.error) return "failed";
  if (report.job) return `${report.job.must_have.length} must-haves`;
  if (report.company) {
    const n = report.company.sources.length;
    return `${n} ${n === 1 ? "source" : "sources"}`;
  }
  if (report.market) return `${report.market.in_demand_skills.length} skills in demand`;
  if (report.linkedin) {
    const li = report.linkedin;
    return `${li.headline_issues.length + li.about_issues.length + li.experience_gaps.length} gaps`;
  }
  return "";
}

export interface ProgramNoteProps {
  snapshot: SessionSnapshot;
  score: ScoreState;
  onSelect: (node: StaffNode) => void;
  onOpenReview: () => void;
  onOpenExport: () => void;
  onResume: () => void;
  resuming: boolean;
  exportOpen: boolean;
}

export function ProgramNote({
  snapshot,
  score,
  onSelect,
  onOpenReview,
  onOpenExport,
  onResume,
  resuming,
  exportOpen,
}: ProgramNoteProps) {
  const gap = snapshot.gap;
  const total = gap ? gap.matched_keywords.length + gap.missing_keywords.length : 0;

  return (
    <aside className="note" aria-label="Program note">
      <h2 className="note-title">Program note</h2>

      <Cue
        snapshot={snapshot}
        score={score}
        onOpenReview={onOpenReview}
        onOpenExport={onOpenExport}
        onResume={onResume}
        resuming={resuming}
        exportOpen={exportOpen}
      />

      {gap ? (
        <button type="button" className="match" onClick={() => onSelect("gap_analysis")}>
          <span className="match-figure">
            {gap.score}
            <small>/100</small>
          </span>
          <span className="match-caption">match for this role</span>
        </button>
      ) : (
        <p className="note-pending">The match score appears after the gap analysis.</p>
      )}

      {gap ? (
        <div className="note-block">
          <button type="button" className="note-link" onClick={() => onSelect("gap_analysis")}>
            Keywords {Math.round(gap.keyword_coverage * 100)}% · {gap.matched_keywords.length} of{" "}
            {total}
          </button>
          <div className="chips">
            {gap.matched_keywords.map((kw) => (
              <span key={kw} className="chip">
                {kw}
              </span>
            ))}
            {gap.missing_keywords.map((kw) => (
              <span key={kw} className="chip chip-missing">
                <span className="sr-only">missing: </span>
                {kw}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <ul className="note-reports" aria-label="Research reports">
        {REPORT_ROWS.map((row) => {
          const status = staffStatus(score, row.node);
          const count = reportCount(snapshot.reports[row.kind]);
          return (
            <li key={row.kind}>
              <button type="button" className="note-row" onClick={() => onSelect(row.node)}>
                <span>{row.name}</span>
                <span className="note-row-count">
                  {count || (status === "tacet" ? "tacet" : status === "running" ? "working" : "—")}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <p className="note-cost">${snapshot.cost_usd.toFixed(4)} spent on models in this session</p>
    </aside>
  );
}

function Cue({
  snapshot,
  score,
  onOpenReview,
  onOpenExport,
  onResume,
  resuming,
  exportOpen,
}: Omit<ProgramNoteProps, "onSelect">) {
  const pending = snapshot.proposals.length;
  if (snapshot.status === "review") {
    return (
      <div className="cue cue-review" role="status">
        <strong>The run waits for you</strong>
        <span>
          {pending} {pending === 1 ? "proposal" : "proposals"} to review before anything is
          exported.
        </span>
        <button type="button" className="btn btn-on-blue" onClick={onOpenReview}>
          Open the review
        </button>
      </div>
    );
  }
  if (snapshot.status === "interrupted") {
    return (
      <div className="cue cue-warn" role="status">
        <strong>The run was cut off</strong>
        <span>The server restarted or slept. Everything up to the last step is saved.</span>
        <button type="button" className="btn" disabled={resuming} onClick={onResume}>
          {resuming ? "Resuming…" : "Resume the run"}
        </button>
      </div>
    );
  }
  if (snapshot.status === "failed") {
    return (
      <div className="cue cue-warn" role="status">
        <strong>The last run failed</strong>
        <span>Send the assistant a message to try again.</span>
      </div>
    );
  }
  if (snapshot.status === "running") {
    const playing = nowPlaying(score);
    return (
      <div className="cue cue-live" role="status">
        <strong>
          <span className="live-dot" aria-hidden="true" />
          {playing ? `Playing: ${playing}` : "Working"}
        </strong>
        <span>The run pauses for your review when the rewrites are checked.</span>
      </div>
    );
  }
  if (snapshot.reviewed) {
    return (
      <div className="cue" role="status">
        <strong>Finished</strong>
        <span>Your reviewed resume and LinkedIn copy are ready.</span>
        {exportOpen ? null : (
          <button type="button" className="btn" onClick={onOpenExport}>
            Open the export
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="cue" role="status">
      <strong>Ready</strong>
      <span>Tell the assistant the role to start the analysis.</span>
    </div>
  );
}
