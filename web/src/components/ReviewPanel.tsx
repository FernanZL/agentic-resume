/**
 * Human-in-the-loop Proposal Diff Review workbench.
 * Highlights [X]% metric placeholders, shows critic flags, reconciles drafts when proposals change,
 * and disables submission unless the session is in 'review' status.
 */

import { type ReactNode, useState } from "react";
import {
  type Action,
  type Decision,
  type GapReport,
  type Proposal,
  type Report,
  type ReviewDraftEntry,
  reconcileReviewDrafts,
} from "../api";
import { IconAlert, IconCheck } from "./Icons";

export interface ReviewPanelProps {
  proposals: Proposal[];
  initialDecisions: Record<string, Decision>;
  drafts?: Record<string, ReviewDraftEntry>;
  onDraftsChange?: (next: Record<string, ReviewDraftEntry>) => void;
  gap?: GapReport | null;
  reports?: Record<string, Report>;
  isReviewPending: boolean;
  submitting: boolean;
  onSubmitReview: (decisions: Record<string, Decision>) => Promise<void>;
  onOpenTimeline?: () => void;
}

const PLACEHOLDER_SPLIT_RE = /(\$?\[[A-Za-z0-9_]+\](?:%|[xX]|[kKmMbB]\b)?)/g;

function renderHighlightedText(text: string): ReactNode[] {
  const parts = text.split(PLACEHOLDER_SPLIT_RE);
  return parts.map((part, idx) => {
    if (PLACEHOLDER_SPLIT_RE.test(part)) {
      PLACEHOLDER_SPLIT_RE.lastIndex = 0;
      return (
        <mark
          key={idx}
          className="placeholder-token"
          title="Metric placeholder — fill in before export"
        >
          {part}
        </mark>
      );
    }
    return <span key={idx}>{part}</span>;
  });
}

export function ReviewPanel({
  proposals,
  initialDecisions,
  drafts,
  onDraftsChange,
  gap,
  reports,
  isReviewPending,
  submitting,
  onSubmitReview,
  onOpenTimeline,
}: ReviewPanelProps) {
  const [internalDrafts, setInternalDrafts] = useState<Record<string, ReviewDraftEntry>>(() =>
    reconcileReviewDrafts(proposals, initialDecisions, {}),
  );

  const effectiveDrafts = reconcileReviewDrafts(
    proposals,
    initialDecisions,
    drafts ?? internalDrafts,
  );

  const updateDrafts = (next: Record<string, ReviewDraftEntry>) => {
    if (onDraftsChange) {
      onDraftsChange(next);
    } else {
      setInternalDrafts(next);
    }
  };

  const getDecision = (p: Proposal): ReviewDraftEntry => {
    return (
      effectiveDrafts[p.id] ?? {
        action: p.status === "ok" ? "accept" : "reject",
        text: p.proposed,
        proposedAtDraft: p.proposed,
      }
    );
  };

  const setProposalAction = (proposal: Proposal, action: Action) => {
    if (!isReviewPending || submitting) return;
    const prev = getDecision(proposal);
    updateDrafts({
      ...effectiveDrafts,
      [proposal.id]: {
        action,
        text: prev.text || proposal.proposed,
        proposedAtDraft: proposal.proposed,
      },
    });
  };

  const setProposalEditText = (proposal: Proposal, text: string) => {
    if (!isReviewPending || submitting) return;
    updateDrafts({
      ...effectiveDrafts,
      [proposal.id]: {
        action: "edit",
        text,
        proposedAtDraft: proposal.proposed,
      },
    });
  };

  const handleAcceptAllOk = () => {
    if (!isReviewPending || submitting) return;
    const next: Record<string, ReviewDraftEntry> = { ...effectiveDrafts };
    proposals.forEach((p) => {
      if (p.status === "ok") {
        next[p.id] = {
          action: "accept",
          text: next[p.id]?.text || p.proposed,
          proposedAtDraft: p.proposed,
        };
      }
    });
    updateDrafts(next);
  };

  const handleSubmit = async () => {
    if (!isReviewPending || submitting) return;
    const payload: Record<string, Decision> = {};
    proposals.forEach((p) => {
      const d = getDecision(p);
      payload[p.id] = {
        action: d.action,
        text: d.action === "edit" ? d.text : "",
      };
    });
    await onSubmitReview(payload);
  };

  if (proposals.length === 0) {
    return (
      <section className="panel empty-state">
        <p>
          No rewrite proposals generated yet. Run the analysis pipeline to review grounded diffs.
        </p>
      </section>
    );
  }

  const okCount = proposals.filter((p) => p.status === "ok").length;
  const flaggedCount = proposals.filter((p) => p.status === "flagged").length;
  const reportCount = reports ? Object.keys(reports).length : 0;

  return (
    <section className="review-stack" aria-label="Proposal diff review">
      {gap ? (
        <div className="telemetry-ribbon" aria-label="Research and gap synthesis summary">
          <div className="ribbon-metric">
            <span className="ribbon-value">{gap.score}/100</span>
            <span className="ribbon-label">ATS Role Match</span>
          </div>
          <div className="ribbon-metric">
            <span className="ribbon-value">{Math.round(gap.keyword_coverage * 100)}%</span>
            <span className="ribbon-label">
              Keywords ({gap.matched_keywords.length} matched · {gap.missing_keywords.length}{" "}
              missing)
            </span>
          </div>
          <div className="ribbon-metric">
            <span className="ribbon-value">{reportCount} Reports</span>
            <span className="ribbon-label">Job · Company · Market · LinkedIn</span>
          </div>
          {onOpenTimeline ? (
            <button type="button" className="btn btn-small btn-secondary" onClick={onOpenTimeline}>
              Inspect Full Reports &amp; DAG
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="panel review-toolbar">
        <div className="review-toolbar-info">
          <h2>Grounded Rewrite Proposals ({proposals.length})</h2>
          <p>
            <strong>{okCount}</strong> verified by anti-fabrication critic
            {flaggedCount > 0 ? ` · ${flaggedCount} flagged with notes` : ""}. Placeholders like{" "}
            <mark className="placeholder-token">[X]%</mark> mark metrics you can customize via{" "}
            <strong>Edit</strong>. Proposals without a decision count as rejected.
          </p>
          {!isReviewPending ? (
            <p className="panel-subcopy">
              Review submission is only available when the session is paused for review. For later
              changes, ask the assistant to revise a proposal in the chat.
            </p>
          ) : null}
        </div>

        <div className="review-toolbar-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleAcceptAllOk}
            disabled={!isReviewPending || submitting}
          >
            <IconCheck width={15} height={15} />
            <span>Accept All OK ({okCount})</span>
          </button>

          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void handleSubmit()}
            disabled={!isReviewPending || submitting}
          >
            {submitting
              ? "Applying Decisions..."
              : isReviewPending
                ? "Submit Review & Finalize"
                : "Review Finalized"}
          </button>
        </div>
      </div>

      <div className="proposal-list">
        {proposals.map((p) => {
          const current = getDecision(p);
          return (
            <article
              key={p.id}
              className={`panel proposal-card proposal-action-${current.action} ${
                p.status === "flagged" ? "proposal-flagged" : ""
              }`}
              aria-label={`Proposal ${p.id}`}
            >
              <div className="proposal-header">
                <div className="proposal-id-group">
                  <span className={`doc-tag doc-tag-${p.document}`}>
                    {p.document === "resume" ? "Resume" : "LinkedIn"}
                  </span>
                  <code className="target-code">{p.target}</code>
                  {p.status === "flagged" ? (
                    <span className="critic-badge critic-flagged">
                      <IconAlert width={13} height={13} />
                      Critic Flagged
                    </span>
                  ) : (
                    <span className="critic-badge critic-ok">
                      <IconCheck width={13} height={13} />
                      Critic Verified
                    </span>
                  )}
                </div>

                <div className="decision-controls" role="group" aria-label={`Decision for ${p.id}`}>
                  <button
                    type="button"
                    className={`decision-btn ${current.action === "accept" ? "selected-accept" : ""}`}
                    disabled={!isReviewPending || submitting}
                    onClick={() => setProposalAction(p, "accept")}
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    className={`decision-btn ${current.action === "edit" ? "selected-edit" : ""}`}
                    disabled={!isReviewPending || submitting}
                    onClick={() => setProposalAction(p, "edit")}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className={`decision-btn ${current.action === "reject" ? "selected-reject" : ""}`}
                    disabled={!isReviewPending || submitting}
                    onClick={() => setProposalAction(p, "reject")}
                  >
                    Reject
                  </button>
                </div>
              </div>

              {p.issues.length > 0 ? (
                <div className="critic-issues-box" role="note">
                  <IconAlert width={15} height={15} />
                  <ul>
                    {p.issues.map((issue, idx) => (
                      <li key={idx}>{issue}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="diff-columns">
                <div className="diff-pane diff-original">
                  <div className="diff-pane-label">Original Source</div>
                  <p className="diff-text">{p.original || "— (New addition)"}</p>
                </div>

                <div className="diff-pane diff-proposed">
                  <div className="diff-pane-label">
                    <span>Proposed Grounded Rewrite</span>
                    {p.placeholders.length > 0 ? (
                      <span className="placeholder-hint">Contains {p.placeholders.join(", ")}</span>
                    ) : null}
                  </div>
                  {current.action === "edit" ? (
                    <textarea
                      aria-label={`Edit text for ${p.id}`}
                      className="input-textarea edit-proposal-textarea"
                      rows={4}
                      disabled={!isReviewPending || submitting}
                      value={current.text}
                      onChange={(e) => setProposalEditText(p, e.target.value)}
                    />
                  ) : (
                    <p className="diff-text">{renderHighlightedText(p.proposed)}</p>
                  )}
                </div>
              </div>

              <div className="proposal-footer">
                <p className="proposal-rationale">
                  <strong>Why:</strong> {p.rationale}
                </p>
                {p.keywords.length > 0 ? (
                  <div className="pill-wrap">
                    {p.keywords.map((kw) => (
                      <span key={kw} className="kw-pill kw-matched">
                        + {kw}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
