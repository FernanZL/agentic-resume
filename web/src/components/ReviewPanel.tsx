/**
 * The review: every proposal as original and rewrite side by side, with the critic's
 * verdict, highlighted placeholders and an accept / edit / reject decision. Submitting
 * is only possible while the run waits at its fermata.
 */

import { type ReactNode, useState } from "react";
import {
  type Action,
  type Decision,
  type Proposal,
  type ReviewDraftEntry,
  reconcileReviewDrafts,
} from "../api";
import { type StaffNode, targetName } from "../score";
import { IconAlert, IconCheck } from "./Icons";

export interface ReviewPanelProps {
  proposals: Proposal[];
  initialDecisions: Record<string, Decision>;
  drafts?: Record<string, ReviewDraftEntry>;
  onDraftsChange?: (next: Record<string, ReviewDraftEntry>) => void;
  isReviewPending: boolean;
  submitting: boolean;
  onSubmitReview: (decisions: Record<string, Decision>) => Promise<void>;
  onOpenStaff?: (node: StaffNode) => void;
}

const PLACEHOLDER_SPLIT_RE = /(\$?\[[A-Za-z0-9_]+\](?:%|[xX]|[kKmMbB]\b)?)/g;

function renderHighlightedText(text: string): ReactNode[] {
  const parts = text.split(PLACEHOLDER_SPLIT_RE);
  return parts.map((part, idx) => {
    if (PLACEHOLDER_SPLIT_RE.test(part)) {
      PLACEHOLDER_SPLIT_RE.lastIndex = 0;
      return (
        <mark key={idx} className="placeholder" title="Fill in your real number before exporting">
          {part}
        </mark>
      );
    }
    return <span key={idx}>{part}</span>;
  });
}

const ACTIONS: Array<{ id: Action; label: string }> = [
  { id: "accept", label: "Accept" },
  { id: "edit", label: "Edit" },
  { id: "reject", label: "Reject" },
];

export function ReviewPanel({
  proposals,
  initialDecisions,
  drafts,
  onDraftsChange,
  isReviewPending,
  submitting,
  onSubmitReview,
  onOpenStaff,
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
      <section className="review review-empty">
        <h2>Review</h2>
        <p>
          No proposals yet. They appear here once the writers finish and the critic has checked
          them.
        </p>
      </section>
    );
  }

  const okCount = proposals.filter((p) => p.status === "ok").length;
  const flaggedCount = proposals.length - okCount;
  const locked = !isReviewPending || submitting;

  return (
    <section className="review" aria-labelledby="review-title">
      <header className="review-head">
        <div>
          <h2 id="review-title">Grounded Rewrite Proposals ({proposals.length})</h2>
          <p>
            {okCount} passed the critic{flaggedCount ? `, ${flaggedCount} still flagged` : ""}. Fill
            in placeholders like <mark className="placeholder">[X]%</mark> with your real numbers
            through Edit. Proposals left without a decision count as rejected.
          </p>
          {!isReviewPending ? (
            <p className="review-closed">
              This review is closed. For later changes, ask the assistant to revise a proposal in
              the chat.
            </p>
          ) : null}
        </div>
        <div className="review-actions">
          <button type="button" className="btn" onClick={handleAcceptAllOk} disabled={locked}>
            <IconCheck width={15} height={15} aria-hidden="true" />
            Accept all that passed ({okCount})
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void handleSubmit()}
            disabled={locked}
          >
            {submitting
              ? "Applying your decisions…"
              : isReviewPending
                ? "Submit Review & Finalize"
                : "Review Finalized"}
          </button>
        </div>
      </header>

      <ol className="proposals">
        {proposals.map((p) => {
          const current = getDecision(p);
          const writer: StaffNode = p.document === "resume" ? "resume_writer" : "linkedin_writer";
          return (
            <li
              key={p.id}
              id={`proposal-${p.id}`}
              tabIndex={-1}
              className={`proposal proposal-${current.action}${p.status === "flagged" ? " proposal-flagged" : ""}`}
              aria-label={`Proposal ${p.id}`}
            >
              <div className="proposal-head">
                <span className="proposal-doc">
                  {p.document === "resume" ? "Resume" : "LinkedIn"}
                </span>
                <span className="proposal-target" title={p.id}>
                  {targetName(p.target)}
                </span>
                {p.status === "flagged" ? (
                  <span className="verdict verdict-flagged">
                    <IconAlert width={14} height={14} aria-hidden="true" />
                    Critic Flagged
                  </span>
                ) : (
                  <span className="verdict">
                    <IconCheck width={14} height={14} aria-hidden="true" />
                    Passed the critic
                  </span>
                )}
                {onOpenStaff ? (
                  <button
                    type="button"
                    className="text-link proposal-source"
                    onClick={() => onOpenStaff(writer)}
                  >
                    Written by the {p.document === "resume" ? "resume" : "LinkedIn"} writer
                  </button>
                ) : null}
                <div className="decision" role="radiogroup" aria-label={`Decision for ${p.id}`}>
                  {ACTIONS.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      role="radio"
                      aria-checked={current.action === a.id}
                      className={`decision-opt decision-${a.id}`}
                      disabled={locked}
                      onClick={() => setProposalAction(p, a.id)}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              </div>

              {p.issues.length ? (
                <ul className="issues" aria-label="The critic's concerns">
                  {p.issues.map((issue, i) => (
                    <li key={i}>{issue}</li>
                  ))}
                </ul>
              ) : null}

              <div className="diff">
                <div className="diff-col">
                  <h3 className="diff-label">Your original</h3>
                  <p className="diff-text">{p.original || "New line: nothing here before."}</p>
                </div>
                <div className="diff-col diff-new">
                  <h3 className="diff-label">
                    Rewrite
                    {p.placeholders.length ? (
                      <span className="diff-hint"> · needs {p.placeholders.join(", ")}</span>
                    ) : null}
                  </h3>
                  {current.action === "edit" ? (
                    <textarea
                      aria-label={`Edit text for ${p.id}`}
                      className="field diff-edit"
                      rows={4}
                      disabled={locked}
                      value={current.text}
                      onChange={(e) => setProposalEditText(p, e.target.value)}
                    />
                  ) : (
                    <p className="diff-text">{renderHighlightedText(p.proposed)}</p>
                  )}
                </div>
              </div>

              <p className="why">
                <strong>Why:</strong> {p.rationale}
              </p>
              {p.keywords.length ? (
                <div className="chips" aria-label="Keywords this rewrite covers">
                  {p.keywords.map((kw) => (
                    <span key={kw} className="chip">
                      {kw}
                    </span>
                  ))}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
