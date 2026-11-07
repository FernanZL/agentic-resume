/**
 * Live Agent Timeline (DAG with parallel researcher and writer lanes) and Research/Gap Report panels.
 */

import { useState } from "react";
import type { GapReport, Report, ReportKind } from "../api";
import { IconAlert, IconCheck, IconSpark } from "./Icons";

export interface NodeTelemetry {
  node: string;
  title: string;
  stage: "intake" | "research" | "gap" | "write" | "critic" | "review" | "finalize";
  status: "waiting" | "running" | "done" | "skipped";
  label: string;
  seconds?: number;
  tools: Array<{ tool: string; summary: string }>;
}

export interface TimelinePanelProps {
  nodes: Record<string, NodeTelemetry>;
  criticRounds: number;
  flaggedCount: number;
  reports: Record<string, Report>;
  gap: GapReport | null;
}

const REPORT_TABS: Array<{ kind: ReportKind; label: string }> = [
  { kind: "job", label: "Job Analysis" },
  { kind: "company", label: "Company Intel" },
  { kind: "market", label: "Market Rubric" },
  { kind: "linkedin", label: "LinkedIn Audit" },
];

function NodeCard({ item }: { item: NodeTelemetry }) {
  return (
    <article
      className={`dag-node dag-status-${item.status}`}
      aria-label={`${item.title}: ${item.status}`}
    >
      <div className="dag-node-top">
        <span className="dag-node-title">{item.title}</span>
        <span className={`dag-badge dag-badge-${item.status}`}>
          {item.status === "running" ? (
            <>
              <span className="pulse-dot" aria-hidden="true" />
              Working
            </>
          ) : item.status === "done" ? (
            <>
              <IconCheck width={12} height={12} />
              {item.seconds !== undefined ? `${item.seconds.toFixed(1)}s` : "Done"}
            </>
          ) : item.status === "skipped" ? (
            "Skipped"
          ) : (
            "Queued"
          )}
        </span>
      </div>
      <p className="dag-node-desc">{item.label}</p>
      {item.tools.length > 0 ? (
        <ul className="dag-tool-list" aria-label={`${item.title} tool calls`}>
          {item.tools.map((t, idx) => (
            <li key={`${t.tool}-${idx}`} className="dag-tool-chip">
              <code>{t.tool}</code>
              <span>{t.summary}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

export function TimelinePanel({
  nodes,
  criticRounds,
  flaggedCount,
  reports,
  gap,
}: TimelinePanelProps) {
  const [activeReportTab, setActiveReportTab] = useState<ReportKind>("job");

  const researchNodes = [
    nodes.job_analyst,
    nodes.company_researcher,
    nodes.market_analyst,
    nodes.linkedin_auditor,
  ].filter(Boolean);

  const writerNodes = [nodes.resume_writer, nodes.linkedin_writer].filter(Boolean);
  const currentReport = reports[activeReportTab];

  return (
    <div className="timeline-stack">
      <section className="panel" aria-label="Multi-agent execution circuit">
        <div className="panel-header">
          <h2>Multi-Agent Execution Pipeline</h2>
          <span className="meta-tag">
            Send Fan-Out · Critic Rounds: {criticRounds}
            {flaggedCount > 0 ? ` · Flagged: ${flaggedCount}` : ""}
          </span>
        </div>

        <div className="dag-flow">
          <div className="dag-stage">{nodes.intake ? <NodeCard item={nodes.intake} /> : null}</div>

          <div className="dag-connector" aria-hidden="true">
            <span>Parallel Research Subagents (Send × 4)</span>
          </div>

          <div className="dag-parallel-grid dag-cols-4">
            {researchNodes.map((n) => (
              <NodeCard key={n.node} item={n} />
            ))}
          </div>

          <div className="dag-connector" aria-hidden="true">
            <span>Deterministic + Rubric Synthesis</span>
          </div>

          <div className="dag-stage">
            {nodes.gap_analysis ? <NodeCard item={nodes.gap_analysis} /> : null}
          </div>

          <div className="dag-connector" aria-hidden="true">
            <span>Parallel Grounded Writers (Resume ∥ LinkedIn)</span>
          </div>

          <div className="dag-parallel-grid dag-cols-2">
            {writerNodes.map((n) => (
              <NodeCard key={n.node} item={n} />
            ))}
          </div>

          <div className="dag-connector" aria-hidden="true">
            <span>Evaluator-Optimizer Loop (≤ 2 rounds) &amp; Human Gate</span>
          </div>

          <div className="dag-parallel-grid dag-cols-3">
            {nodes.critic ? <NodeCard item={nodes.critic} /> : null}
            {nodes.review ? <NodeCard item={nodes.review} /> : null}
            {nodes.finalize ? <NodeCard item={nodes.finalize} /> : null}
          </div>
        </div>
      </section>

      {gap ? (
        <section className="panel" aria-label="ATS Gap Analysis Scoreboard">
          <div className="panel-header">
            <h2>ATS &amp; Structural Gap Report</h2>
            <span className="meta-tag">
              Keyword Coverage: {Math.round(gap.keyword_coverage * 100)}%
            </span>
          </div>

          <div className="gap-overview-grid">
            <div className="gap-score-box">
              <div className="gap-score-readout">
                <span className="gap-score-number">{gap.score}</span>
                <span className="gap-score-denom">/ 100</span>
              </div>
              <p className="gap-score-caption">Composite Role Match</p>
              <div
                className="gap-meter"
                role="progressbar"
                aria-valuenow={gap.score}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div className="gap-meter-fill" style={{ width: `${gap.score}%` }} />
              </div>
            </div>

            <div className="gap-keywords-col">
              <div className="kw-group">
                <h3>Matched Target Keywords ({gap.matched_keywords.length})</h3>
                <div className="pill-wrap">
                  {gap.matched_keywords.map((kw) => (
                    <span key={kw} className="kw-pill kw-matched">
                      <IconCheck width={12} height={12} />
                      {kw}
                    </span>
                  ))}
                </div>
              </div>

              <div className="kw-group">
                <h3>Missing Target Keywords ({gap.missing_keywords.length})</h3>
                <div className="pill-wrap">
                  {gap.missing_keywords.map((kw) => (
                    <span key={kw} className="kw-pill kw-missing">
                      {kw}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="gap-details-grid">
            <div>
              <h3>Prioritized Rewrite Plan</h3>
              <ol className="structured-list">
                {gap.priorities.map((p, idx) => (
                  <li key={idx}>{p}</li>
                ))}
              </ol>
            </div>
            <div>
              <h3>Strengths &amp; Format Audit</h3>
              <ul className="structured-list">
                {gap.strengths.map((s, idx) => (
                  <li key={`str-${idx}`}>{s}</li>
                ))}
                {gap.format_issues.map((issue, idx) => (
                  <li key={`fmt-${idx}`} className="text-warning">
                    <strong>Format Issue:</strong> {issue}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      ) : null}

      <section className="panel" aria-label="Subagent Research Reports">
        <div className="panel-header">
          <h2>Subagent Intelligence Reports</h2>
          <div className="segmented-tabs" role="tablist" aria-label="Select researcher report">
            {REPORT_TABS.map((t) => {
              const ready = Boolean(reports[t.kind]);
              return (
                <button
                  key={t.kind}
                  type="button"
                  role="tab"
                  aria-selected={activeReportTab === t.kind}
                  className={`seg-tab ${activeReportTab === t.kind ? "active" : ""}`}
                  onClick={() => setActiveReportTab(t.kind)}
                >
                  <span>{t.label}</span>
                  {ready ? <span className="dot-ready" aria-hidden="true" /> : null}
                </button>
              );
            })}
          </div>
        </div>

        {!currentReport ? (
          <div className="empty-state">
            <IconSpark width={18} height={18} />
            <p>Waiting for the {activeReportTab} researcher subagent to finish...</p>
          </div>
        ) : currentReport.error ? (
          <div className="banner banner-error">
            <IconAlert width={16} height={16} />
            <span>{currentReport.error}</span>
          </div>
        ) : (
          <div className="report-body">
            {currentReport.job ? (
              <div className="report-grid">
                <p className="report-summary">
                  <strong>{currentReport.job.seniority || "Target Role"}:</strong>{" "}
                  {currentReport.job.summary}
                </p>
                <div className="report-cols">
                  <div>
                    <h3>Must-Have Requirements</h3>
                    <ul className="structured-list">
                      {currentReport.job.must_have.map((m, i) => (
                        <li key={i}>{m}</li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <h3>Core Responsibilities &amp; Nice-to-Haves</h3>
                    <ul className="structured-list">
                      {currentReport.job.responsibilities.map((r, i) => (
                        <li key={`resp-${i}`}>{r}</li>
                      ))}
                      {currentReport.job.nice_to_have.map((n, i) => (
                        <li key={`nice-${i}`}>
                          <em>Nice to have:</em> {n}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            ) : null}

            {currentReport.company ? (
              <div className="report-grid">
                <p className="report-summary">{currentReport.company.summary}</p>
                <div className="report-cols">
                  <div>
                    <h3>Products &amp; Tech Stack</h3>
                    <p className="report-meta-line">
                      <strong>Products:</strong> {currentReport.company.products.join(" · ") || "—"}
                    </p>
                    <div className="pill-wrap">
                      {currentReport.company.tech_stack.map((tech) => (
                        <span key={tech} className="kw-pill">
                          {tech}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div>
                    <h3>Engineering Culture, Tone &amp; News</h3>
                    <p className="report-meta-line">
                      <strong>Tone:</strong> {currentReport.company.tone}
                    </p>
                    <ul className="structured-list">
                      {currentReport.company.values.map((v, i) => (
                        <li key={`val-${i}`}>{v}</li>
                      ))}
                      {currentReport.company.recent_news.map((n, i) => (
                        <li key={`news-${i}`}>{n}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            ) : null}

            {currentReport.market ? (
              <div className="report-grid">
                <p className="report-summary">{currentReport.market.summary}</p>
                <div className="report-cols">
                  <div>
                    <h3>Level &amp; Seniority Signals</h3>
                    <ul className="structured-list">
                      {currentReport.market.level_signals.map((sig, i) => (
                        <li key={i}>{sig}</li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <h3>In-Demand Skills &amp; Title Variants</h3>
                    <p className="report-meta-line">
                      <strong>Titles:</strong> {currentReport.market.title_variants.join(" · ")}
                    </p>
                    <div className="pill-wrap">
                      {currentReport.market.in_demand_skills.map((sk) => (
                        <span key={sk} className="kw-pill">
                          {sk}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            {currentReport.linkedin ? (
              <div className="report-grid">
                <p className="report-summary">{currentReport.linkedin.summary}</p>
                <div className="report-cols">
                  <div>
                    <h3>Headline &amp; About Gaps</h3>
                    <ul className="structured-list">
                      {currentReport.linkedin.headline_issues.map((h, i) => (
                        <li key={`hl-${i}`}>{h}</li>
                      ))}
                      {currentReport.linkedin.about_issues.map((a, i) => (
                        <li key={`ab-${i}`}>{a}</li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <h3>Experience Gaps &amp; Inconsistencies</h3>
                    <ul className="structured-list">
                      {currentReport.linkedin.experience_gaps.map((g, i) => (
                        <li key={`gap-${i}`}>{g}</li>
                      ))}
                      {currentReport.linkedin.inconsistencies.map((inc, i) => (
                        <li key={`inc-${i}`} className="text-warning">
                          {inc}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}
