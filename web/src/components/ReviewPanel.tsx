/**
 * The review: every proposal as original and rewrite side by side, with the critic's
 * verdict, highlighted placeholders and an accept / edit / reject decision. Submitting
 * is only possible while the run waits at its fermata.
 */

import { type ReactNode, useState } from "react";
import {
  type Action,
  type CandidateProfile,
  type Decision,
  type Proposal,
  type ReviewDraftEntry,
  type LinkedInGuidanceItem,
  getLinkedInCopyIssues,
  getLinkedInGuidance,
  reconcileReviewDrafts,
} from "../api";
import { type StaffNode, targetName } from "../score";
import { IconAlert, IconCheck } from "./Icons";

export interface ReviewPanelProps {
  proposals: Proposal[];
  profile?: CandidateProfile | null;
  linkedinGuidance?: Record<string, LinkedInGuidanceItem>;
  locked?: boolean;
  initialDecisions: Record<string, Decision>;
  drafts?: Record<string, ReviewDraftEntry>;
  onDraftsChange?: (next: Record<string, ReviewDraftEntry>) => void;
  isReviewPending: boolean;
  isReviewed?: boolean;
  submitting: boolean;
  amending?: boolean;
  onSubmitReview: (decisions: Record<string, Decision>) => Promise<void>;
  onAmendReview?: (decisions: Record<string, Decision>) => Promise<void>;
  onAskAboutProposal?: (proposal: Proposal) => void;
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
  profile,
  linkedinGuidance: guidanceByTarget,
  locked = false,
  initialDecisions,
  drafts,
  onDraftsChange,
  isReviewPending,
  isReviewed = false,
  submitting,
  amending = false,
  onSubmitReview,
  onAmendReview,
  onAskAboutProposal,
  onOpenStaff,
}: ReviewPanelProps) {
  const [internalDrafts, setInternalDrafts] = useState<Record<string, ReviewDraftEntry>>(() =>
    reconcileReviewDrafts(proposals, initialDecisions, {}),
  );

  const effectiveDrafts = reconcileReviewDrafts(
    proposals,
    initialDecisions,
    drafts ?? internalDrafts,
    { preserveEditsOnConflict: true },
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
        action: null,
        text: p.proposed,
        proposedAtDraft: p.proposed,
      }
    );
  };

  const canEditDrafts = isReviewPending || Boolean(isReviewed && onAmendReview);
  const editLocked = !canEditDrafts || submitting || amending || locked;
  const submitLocked = !isReviewPending || submitting || locked;

  const setProposalAction = (proposal: Proposal, action: Action) => {
    if (editLocked) return;
    const prev = getDecision(proposal);
    updateDrafts({
      ...effectiveDrafts,
      [proposal.id]: {
        action,
        text: prev.text || proposal.proposed,
        proposedAtDraft: proposal.proposed,
        issues: prev.issues,
      },
    });
  };

  const setProposalEditText = (proposal: Proposal, text: string) => {
    if (editLocked) return;
    const prev = getDecision(proposal);
    updateDrafts({
      ...effectiveDrafts,
      [proposal.id]: {
        action: "edit",
        text,
        proposedAtDraft: proposal.proposed,
        issues: prev.issues,
      },
    });
  };

  const isCriticFlagged = (p: Proposal) => p.status === "flagged" || p.issues.length > 0;

  const getAdvisoryIssues = (p: Proposal): string[] => {
    const current = getDecision(p);
    const activeText = current.action === "edit" ? current.text : p.proposed;
    const linkedinGuidance =
      p.document === "linkedin"
        ? getLinkedInGuidance(p.target, profile, guidanceByTarget?.[p.target])
        : null;
    const linkedinCopyIssues =
      p.document === "linkedin"
        ? getLinkedInCopyIssues(p.target, activeText, profile, linkedinGuidance ?? undefined)
        : [];
    return Array.from(new Set([...(current.issues ?? []), ...linkedinCopyIssues]));
  };

  const isCleanToAccept = (p: Proposal) => !isCriticFlagged(p) && getAdvisoryIssues(p).length === 0;

  const handleAcceptAllOk = () => {
    if (submitLocked) return;
    const next: Record<string, ReviewDraftEntry> = { ...effectiveDrafts };
    proposals.forEach((p) => {
      if (isCleanToAccept(p) && next[p.id]?.action === null) {
        next[p.id] = {
          action: "accept",
          text: next[p.id]?.text || p.proposed,
          proposedAtDraft: p.proposed,
        };
      }
    });
    updateDrafts(next);
  };

  const hasEmptyEdit = proposals.some((p) => {
    const d = getDecision(p);
    return d.action === "edit" && !d.text.trim();
  });
  const hasStaleDraft = proposals.some((p) => getDecision(p).stale);

  const buildPayload = (): Record<string, Decision> => {
    const payload: Record<string, Decision> = {};
    proposals.forEach((p) => {
      const d = getDecision(p);
      payload[p.id] = {
        action: d.action ?? "reject",
        text: d.action === "edit" ? d.text.trim() : "",
      };
    });
    return payload;
  };

  const handleSubmit = async () => {
    if (submitLocked || hasEmptyEdit || hasStaleDraft) return;
    await onSubmitReview(buildPayload());
  };

  const handleAmend = async () => {
    if (!isReviewed || !onAmendReview || editLocked || hasEmptyEdit || hasStaleDraft) return;
    await onAmendReview(buildPayload());
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

  const okCount = proposals.filter((p) => !isCriticFlagged(p)).length;
  const flaggedCount = proposals.length - okCount;
  const undecidedCount = proposals.filter((p) => getDecision(p).action === null).length;
  const passedUndecidedCount = proposals.filter(
    (p) => isCleanToAccept(p) && getDecision(p).action === null,
  ).length;

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
          {isReviewPending ? <p role="status">{undecidedCount} awaiting your decision.</p> : null}
          {!isReviewPending ? (
            <p className="review-closed">
              {isReviewed && onAmendReview
                ? "Draft changes here or ask the assistant for wording, then choose Apply Reviewed Edits."
                : "This review is closed. For later changes, ask the assistant to revise a proposal in the chat."}
            </p>
          ) : null}
        </div>
        <div className="review-actions">
          <button
            type="button"
            className="btn"
            onClick={handleAcceptAllOk}
            disabled={submitLocked || passedUndecidedCount === 0}
          >
            <IconCheck width={15} height={15} aria-hidden="true" />
            Accept all that passed ({passedUndecidedCount})
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void handleSubmit()}
            disabled={submitLocked || hasEmptyEdit || hasStaleDraft}
          >
            {submitting
              ? "Applying your decisions…"
              : isReviewPending
                ? "Submit Review & Finalize"
                : "Review Finalized"}
          </button>
          {!isReviewPending && isReviewed && onAmendReview ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void handleAmend()}
              disabled={editLocked || hasEmptyEdit || hasStaleDraft}
            >
              {amending ? "Applying reviewed edits…" : "Apply Reviewed Edits"}
            </button>
          ) : null}
        </div>
      </header>

      {hasEmptyEdit ? (
        <p role="alert">Fill in each edited proposal, or choose Reject before submitting.</p>
      ) : null}
      <ol className="proposals">
        {proposals.map((p) => {
          const current = getDecision(p);
          const writer: StaffNode = p.document === "resume" ? "resume_writer" : "linkedin_writer";
          const activeText = current.action === "edit" ? current.text : p.proposed;
          const linkedinGuidance =
            p.document === "linkedin"
              ? getLinkedInGuidance(p.target, profile, guidanceByTarget?.[p.target])
              : null;
          const advisoryIssues = getAdvisoryIssues(p);
          const criticFlagged = isCriticFlagged(p);
          const isFlagged = criticFlagged || advisoryIssues.length > 0;
          const isEmptyEdit = current.action === "edit" && !current.text.trim();
          const placeholders = p.placeholders ?? [];
          const keywords = p.keywords ?? [];
          const rationaleText = p.rationale || "";

          return (
            <li
              key={p.id}
              id={`proposal-${p.id}`}
              tabIndex={-1}
              className={`proposal proposal-${current.action ?? "undecided"}${isFlagged ? " proposal-flagged" : ""}`}
              aria-label={`Proposal ${p.id}`}
            >
              <div className="proposal-head">
                <span className="proposal-doc">
                  {p.document === "resume" ? "Resume" : "LinkedIn"}
                </span>
                <span className="proposal-target" title={p.id}>
                  {p.document === "linkedin" &&
                  /^(?:li|exp)\d+$/.test(p.target) &&
                  guidanceByTarget?.[p.target]
                    ? guidanceByTarget[p.target]!.section
                    : targetName(p.target, profile)}
                </span>
                {criticFlagged ? (
                  <span className="verdict verdict-flagged">
                    <IconAlert width={14} height={14} aria-hidden="true" />
                    Critic Flagged
                  </span>
                ) : advisoryIssues.length > 0 ? (
                  <span className="verdict verdict-flagged">
                    <IconAlert width={14} height={14} aria-hidden="true" />
                    Advisory Flagged
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
                {onAskAboutProposal ? (
                  <button
                    type="button"
                    className="text-link proposal-source"
                    onClick={() => onAskAboutProposal(p)}
                  >
                    Ask in chat
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
                      disabled={editLocked}
                      onClick={() => setProposalAction(p, a.id)}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              </div>

              {linkedinGuidance ? (
                <div className="linkedin-guide" aria-label={`LinkedIn placement for ${p.id}`}>
                  <div className="linkedin-meta">
                    <span>
                      <strong>Where to paste:</strong> {linkedinGuidance.section} ·{" "}
                      {linkedinGuidance.field}
                    </span>
                    <span className="linkedin-count">
                      {activeText.length}
                      {linkedinGuidance.character_limit !== null
                        ? ` / ${linkedinGuidance.character_limit} chars`
                        : " chars"}
                    </span>
                    {linkedinGuidance.character_limit !== null && !linkedinGuidance.verified ? (
                      <span className="linkedin-advisory">Advisory limit (unverified)</span>
                    ) : null}
                  </div>
                  <p className="linkedin-instructions">{linkedinGuidance.instructions}</p>
                </div>
              ) : null}

              {p.issues.length ? (
                <ul className="issues" aria-label="The critic's concerns">
                  {p.issues.map((issue, i) => (
                    <li key={i}>{issue}</li>
                  ))}
                </ul>
              ) : null}

              {advisoryIssues.length ? (
                <ul className="issues" aria-label="Advisory & draft checks">
                  {advisoryIssues.map((issue, i) => (
                    <li key={i}>{issue}</li>
                  ))}
                </ul>
              ) : null}

              {current.stale ? (
                <p className="ev-note" role="status">
                  This proposal changed in another turn—verify your draft before submitting.
                </p>
              ) : null}

              <div className="diff">
                <div className="diff-col">
                  <h3 className="diff-label">Your original</h3>
                  <p className="diff-text">{p.original || "New line: nothing here before."}</p>
                </div>
                <div className="diff-col diff-new">
                  <h3 className="diff-label">
                    Rewrite
                    {placeholders.length ? (
                      <span className="diff-hint"> · needs {placeholders.join(", ")}</span>
                    ) : null}
                  </h3>
                  {current.action === "edit" ? (
                    <>
                      <textarea
                        aria-label={`Edit text for ${p.id}`}
                        className="field diff-edit"
                        rows={4}
                        disabled={editLocked}
                        value={current.text}
                        onChange={(e) => setProposalEditText(p, e.target.value)}
                      />
                      {isEmptyEdit ? (
                        <p className="ev-note" role="alert">
                          Edited text cannot be empty. Enter your wording or choose Accept / Reject.
                        </p>
                      ) : null}
                    </>
                  ) : (
                    <p className="diff-text">{renderHighlightedText(p.proposed)}</p>
                  )}
                </div>
              </div>

              {rationaleText ? (
                <p className="why">
                  <strong>Why:</strong> {rationaleText}
                </p>
              ) : null}
              {keywords.length ? (
                <div className="chips" aria-label="Keywords this rewrite covers">
                  {keywords.map((kw) => (
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
