/**
 * The app shell: start screen and /s/<id> routing, the session workspace (chat, the
 * score with review and export, and the program note), the live event stream, the
 * passcode gate and the session states (review, interrupted, failed, budget, 404).
 */

import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type ChatMessage,
  type Decision,
  type DraftSuggestion,
  type Event,
  type Proposal,
  type ReviewDraftEntry,
  type SessionSnapshot,
  type SessionStatus,
  activateDemoSessionSnapshot,
  amendSession,
  askSession,
  formatRunFailedError,
  getSession,
  isMockMode,
  parseSessionIdFromPath,
  reanalyzeSession,
  reconcileReviewDrafts,
  resumeSession,
  sendMessage,
  setMockMode,
  submitReview,
  updateMockSnapshotState,
} from "./api";
import { ChatText } from "./components/ChatText";
import { ExportPanel } from "./components/ExportPanel";
import { IconAlert, IconCheck, IconKey, IconSend } from "./components/Icons";
import { ProgramNote } from "./components/ProgramNote";
import { ReviewPanel } from "./components/ReviewPanel";
import { ScorePanel } from "./components/ScorePanel";
import { StartScreen } from "./components/StartScreen";
import { HttpError, getStoredPasscode, setStoredPasscode } from "./connection";
import { connectSessionEvents } from "./events";
import { MOCK_GAP_REPORT, MOCK_PROPOSALS, MOCK_REPORTS } from "./mock/fixtures";
import {
  STAVES,
  type ScoreState,
  type StaffNode,
  applyEvent,
  emptyScore,
  nowPlaying,
  staffStatus,
  targetName,
} from "./score";

type WorkspaceTab = "score" | "review" | "export";

const TABS: Array<{ id: WorkspaceTab; label: string }> = [
  { id: "score", label: "Score" },
  { id: "review", label: "Review" },
  { id: "export", label: "Export" },
];

const STATUS_LINE: Record<SessionStatus, string> = {
  idle: "Idle",
  running: "Running",
  review: "Waiting for your review",
  interrupted: "Interrupted",
  failed: "Failed",
};

export function App() {
  const [sessionId, setSessionId] = useState<string | null>(() =>
    parseSessionIdFromPath(window.location.pathname),
  );
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [loadingSession, setLoadingSession] = useState(false);
  const [notFoundSessionId, setNotFoundSessionId] = useState<string | null>(null);

  const [score, setScore] = useState<ScoreState>(emptyScore);
  const [selectedStaff, setSelectedStaff] = useState<StaffNode | null>(null);
  const [streamingTokens, setStreamingTokens] = useState("");
  const [reviewDrafts, setReviewDrafts] = useState<Record<string, ReviewDraftEntry>>({});
  const [stagedAdditions, setStagedAdditions] = useState<Proposal[]>([]);
  const [suggestionsByMessageId, setSuggestionsByMessageId] = useState<
    Record<string, DraftSuggestion & { revision?: string; draftAtRequest?: string }>
  >({});
  const [loadedSuggestionIds, setLoadedSuggestionIds] = useState<Record<string, boolean>>({});
  const [staleSuggestionNotice, setStaleSuggestionNotice] = useState<Record<string, string>>({});
  const [focusedProposalId, setFocusedProposalId] = useState<string | null>(null);
  const [reviewConflict, setReviewConflict] = useState(false);
  const [draftNotice, setDraftNotice] = useState("");
  const draftBaseRevisionRef = useRef<string | null>(null);
  const dirtyDraftIdsRef = useRef<Set<string>>(new Set());
  const reviewDraftsRef = useRef(reviewDrafts);
  reviewDraftsRef.current = reviewDrafts;
  const stagedAdditionsRef = useRef(stagedAdditions);
  stagedAdditionsRef.current = stagedAdditions;

  const [activeTab, setActiveTab] = useState<WorkspaceTab>("score");
  const [chatInput, setChatInput] = useState("");
  const [sendingMessage, setSendingMessage] = useState(false);
  const [submittingReview, setSubmittingReview] = useState(false);
  const [amendingReview, setAmendingReview] = useState(false);
  const [resumingRun, setResumingRun] = useState(false);

  const [showReanalyzeConfirm, setShowReanalyzeConfirm] = useState(false);
  const [reanalyzeTitle, setReanalyzeTitle] = useState("");
  const [reanalyzeCompany, setReanalyzeCompany] = useState("");
  const [reanalyzeJobText, setReanalyzeJobText] = useState("");
  const [reanalyzeJobUrl, setReanalyzeJobUrl] = useState("");
  const [reanalyzeNotes, setReanalyzeNotes] = useState("");
  const [reanalyzing, setReanalyzing] = useState(false);

  const [passcode, setPasscodeState] = useState<string>(() => getStoredPasscode());
  const [showPasscode, setShowPasscode] = useState(false);
  const [mockActive, setMockActive] = useState<boolean>(() => isMockMode());

  const [errorBanner, setErrorBanner] = useState<{
    code: "bad_passcode" | "budget_exceeded" | "generic";
    message: string;
  } | null>(null);

  const refreshDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const snapshotReqGenRef = useRef(0);
  const snapshotAbortRef = useRef<AbortController | null>(null);
  const replayUntilRef = useRef(0);
  const activeSessionIdRef = useRef<string | null>(sessionId);
  activeSessionIdRef.current = sessionId;

  const allProposals = useMemo(() => {
    const base = snapshot?.proposals ?? [];
    if (stagedAdditions.length === 0) return base;
    const baseIds = new Set(base.map((p) => p.id));
    return [...base, ...stagedAdditions.filter((p) => !baseIds.has(p.id))];
  }, [snapshot?.proposals, stagedAdditions]);

  const navigateToSession = useCallback((nextId: string | null, pushHistory = true) => {
    snapshotReqGenRef.current += 1;
    snapshotAbortRef.current?.abort();
    snapshotAbortRef.current = null;
    if (refreshDebounceRef.current !== null) {
      clearTimeout(refreshDebounceRef.current);
      refreshDebounceRef.current = null;
    }
    if (pushHistory) {
      const nextPath = nextId ? `/s/${encodeURIComponent(nextId)}` : "/";
      if (window.location.pathname !== nextPath) {
        window.history.pushState({}, "", nextPath);
      }
    }
    activeSessionIdRef.current = nextId;
    setNotFoundSessionId(null);
    setErrorBanner(null);
    setStreamingTokens("");
    setReviewDrafts({});
    draftBaseRevisionRef.current = null;
    dirtyDraftIdsRef.current.clear();
    setReviewConflict(false);
    setDraftNotice("");
    setStagedAdditions([]);
    setSuggestionsByMessageId({});
    setLoadedSuggestionIds({});
    setStaleSuggestionNotice({});
    setFocusedProposalId(null);
    setShowReanalyzeConfirm(false);
    setScore(emptyScore());
    setSelectedStaff(null);
    setSnapshot(null);
    if (nextId === "demo" && isMockMode()) {
      activateDemoSessionSnapshot();
      setActiveTab("review");
    } else {
      setActiveTab("score");
    }
    setSessionId(nextId);
  }, []);

  useEffect(() => {
    const onPopState = () =>
      navigateToSession(parseSessionIdFromPath(window.location.pathname), false);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [navigateToSession]);

  const handleApiError = useCallback(
    (err: unknown, targetSessionId?: string) => {
      if (err instanceof Error && err.name === "AbortError") return;
      if (err instanceof HttpError) {
        if (err.status === 404 || err.detail === "session_not_found") {
          setNotFoundSessionId(targetSessionId ?? sessionId ?? "unknown");
          setSnapshot(null);
          return;
        }
        if (err.status === 401 || err.detail === "bad_passcode") {
          setErrorBanner({
            code: "bad_passcode",
            message: "This demo needs its passcode before it can start or change a session.",
          });
          setShowPasscode(true);
          return;
        }
        if (err.status === 429 || err.detail === "budget_exceeded") {
          setErrorBanner({
            code: "budget_exceeded",
            message: formatRunFailedError("budget_exceeded"),
          });
          return;
        }
        if (err.detail === "stale_review") {
          setActiveTab("review");
          setErrorBanner({
            code: "generic",
            message:
              "Saved decisions changed in another tab. Your draft text is preserved; compare it with the latest version before applying.",
          });
          return;
        }
        setErrorBanner({
          code: "generic",
          message: `The server answered ${err.status}: ${err.detail}`,
        });
        return;
      }
      const msg = err instanceof Error ? err.message : "Couldn't reach the server.";
      setErrorBanner({ code: "generic", message: msg });
    },
    [sessionId],
  );

  const refreshSnapshot = useCallback(
    async (id: string): Promise<SessionSnapshot | null> => {
      snapshotAbortRef.current?.abort();
      const controller = new AbortController();
      snapshotAbortRef.current = controller;
      const gen = ++snapshotReqGenRef.current;
      try {
        const snap = await getSession(id, controller.signal);
        if (
          controller.signal.aborted ||
          gen !== snapshotReqGenRef.current ||
          activeSessionIdRef.current !== id
        ) {
          return null;
        }
        setNotFoundSessionId(null);
        setSnapshot(snap);
        const dirty = dirtyDraftIdsRef.current.size > 0;
        if (
          dirty &&
          draftBaseRevisionRef.current &&
          snap.revision &&
          draftBaseRevisionRef.current !== snap.revision
        ) {
          setReviewConflict(true);
        }
        const nextDrafts = reconcileReviewDrafts(
          snap.proposals,
          snap.decisions,
          dirty ? reviewDraftsRef.current : {},
          { preserveEditsOnConflict: true, additions: stagedAdditionsRef.current },
        );
        if (Object.values(nextDrafts).some((d) => d.stale)) {
          setDraftNotice(
            "A proposal changed. Your text is preserved; compare it with the latest saved version before applying it.",
          );
          setReviewConflict(true);
        }
        setReviewDrafts(nextDrafts);
        if (snap.status === "review") setActiveTab("review");
        return snap;
      } catch (err) {
        if (
          controller.signal.aborted ||
          (err instanceof Error && err.name === "AbortError") ||
          gen !== snapshotReqGenRef.current ||
          activeSessionIdRef.current !== id
        ) {
          return null;
        }
        handleApiError(err, id);
        return null;
      }
    },
    [handleApiError],
  );

  const scheduleDebouncedRefresh = useCallback(
    (id: string) => {
      if (refreshDebounceRef.current !== null) clearTimeout(refreshDebounceRef.current);
      refreshDebounceRef.current = setTimeout(() => {
        refreshDebounceRef.current = null;
        void refreshSnapshot(id);
      }, 300);
    },
    [refreshSnapshot],
  );

  const handleSseEvent = useCallback(
    (ev: Event) => {
      setScore((prev) => applyEvent(prev, ev));
      // The history before the snapshot only redraws the score: no tab jumps or banners.
      if (ev.id <= replayUntilRef.current) return;
      const target = ev.session_id || sessionId;

      if (ev.type === "token") {
        const chunk = typeof ev.data.text === "string" ? ev.data.text : "";
        if (chunk) setStreamingTokens((prev) => prev + chunk);
      } else if (ev.type === "message") {
        setStreamingTokens("");
        const msg = ev.data as unknown as ChatMessage;
        if (msg?.id && msg?.content) {
          setSnapshot((prev) => {
            if (!prev || prev.messages.some((m) => m.id === msg.id)) return prev;
            return { ...prev, messages: [...prev.messages, msg] };
          });
        }
      } else if (["report_ready", "gap_ready", "proposals_ready", "critique"].includes(ev.type)) {
        if (target) scheduleDebouncedRefresh(target);
      } else if (ev.type === "review_required") {
        setSnapshot((prev) => (prev ? { ...prev, status: "review" } : prev));
        setActiveTab("review");
        if (target) void refreshSnapshot(target);
      } else if (ev.type === "run_started") {
        setSnapshot((prev) => (prev ? { ...prev, status: "running" } : prev));
      } else if (ev.type === "run_completed") {
        setStreamingTokens("");
        const nextStatus = (ev.data.status as SessionStatus | undefined) ?? "idle";
        setSnapshot((prev) => (prev ? { ...prev, status: nextStatus } : prev));
        if (target) void refreshSnapshot(target);
      } else if (ev.type === "run_failed") {
        setStreamingTokens("");
        const code = String(ev.data.error ?? "internal_error");
        setSnapshot((prev) => (prev ? { ...prev, status: "failed" } : prev));
        setErrorBanner({
          code: code === "budget_exceeded" ? "budget_exceeded" : "generic",
          message: formatRunFailedError(code),
        });
      }
    },
    [refreshSnapshot, scheduleDebouncedRefresh, sessionId],
  );

  useEffect(() => {
    if (!sessionId) return;
    let cleanupStream: (() => void) | undefined;
    let cancelled = false;
    const init = async () => {
      setLoadingSession(true);
      setNotFoundSessionId(null);
      try {
        const snap = await refreshSnapshot(sessionId);
        if (cancelled || !snap) return;
        // Replay the whole history so the score can be drawn, then go on live.
        replayUntilRef.current = snap.last_event_id;
        setScore(emptyScore());
        cleanupStream = connectSessionEvents(sessionId, 0, { onEvent: handleSseEvent });
      } finally {
        if (!cancelled) setLoadingSession(false);
      }
    };
    void init();
    return () => {
      cancelled = true;
      snapshotAbortRef.current?.abort();
      if (refreshDebounceRef.current !== null) {
        clearTimeout(refreshDebounceRef.current);
        refreshDebounceRef.current = null;
      }
      cleanupStream?.();
    };
  }, [sessionId, handleSseEvent, refreshSnapshot]);

  const handleSavePasscode = (e: FormEvent) => {
    e.preventDefault();
    setStoredPasscode(passcode);
    setShowPasscode(false);
    if (errorBanner?.code === "bad_passcode") setErrorBanner(null);
  };

  const handleToggleMockMode = () => {
    const next = !mockActive;
    setMockMode(next);
    setMockActive(next);
    setErrorBanner(null);
  };

  const handleReviewDraftsChange = (next: Record<string, ReviewDraftEntry>) => {
    if (!snapshot) return;
    for (const [id, draft] of Object.entries(next)) {
      const previous = reviewDraftsRef.current[id];
      if (!previous || previous.action !== draft.action || previous.text !== draft.text) {
        dirtyDraftIdsRef.current.add(id);
      }
    }
    if (dirtyDraftIdsRef.current.size && draftBaseRevisionRef.current === null) {
      draftBaseRevisionRef.current = snapshot.revision ?? "";
    }
    reviewDraftsRef.current = next;
    setReviewDrafts(next);
  };

  const reconcileConflict = (keepDrafts: boolean) => {
    if (!snapshot) return;
    const saved = reconcileReviewDrafts(allProposals, snapshot.decisions, {});
    if (keepDrafts) {
      for (const id of dirtyDraftIdsRef.current) {
        const proposal = allProposals.find((p) => p.id === id);
        const draft = reviewDraftsRef.current[id];
        if (proposal && draft)
          saved[id] = { ...draft, proposedAtDraft: proposal.proposed, stale: false };
      }
      draftBaseRevisionRef.current = snapshot.revision ?? "";
    } else {
      dirtyDraftIdsRef.current.clear();
      draftBaseRevisionRef.current = null;
      setStagedAdditions([]);
    }
    reviewDraftsRef.current = saved;
    setReviewDrafts(saved);
    setReviewConflict(false);
    setDraftNotice("");
  };

  const openReanalyzeDialog = (prefillTitle?: string) => {
    if (!snapshot) return;
    if (snapshot.status === "review" || snapshot.status === "running") {
      setErrorBanner({
        code: "generic",
        message:
          snapshot.status === "review"
            ? "Finish or submit your review before starting a fresh analysis."
            : "Wait for the current run to finish before starting a fresh analysis.",
      });
      return;
    }
    setReanalyzeTitle(prefillTitle?.trim() || snapshot.target.title);
    setReanalyzeCompany(snapshot.target.company);
    setReanalyzeJobText(snapshot.target.job_text);
    setReanalyzeJobUrl(snapshot.target.job_url);
    setReanalyzeNotes(snapshot.target.notes ?? "");
    setShowReanalyzeConfirm(true);
  };

  const handleConfirmReanalyze = async (e: FormEvent) => {
    e.preventDefault();
    if (!snapshot || reanalyzing) return;
    const title = reanalyzeTitle.trim();
    if (!title) return;
    setReanalyzing(true);
    setErrorBanner(null);
    try {
      await reanalyzeSession(snapshot.session_id, {
        target: {
          title,
          company: reanalyzeCompany.trim(),
          job_url: reanalyzeJobUrl.trim(),
          job_text: reanalyzeJobText.trim(),
          notes: reanalyzeNotes.trim(),
        },
        confirmed: true,
      });
      setShowReanalyzeConfirm(false);
      setStagedAdditions([]);
      setReviewDrafts({});
      draftBaseRevisionRef.current = null;
      dirtyDraftIdsRef.current.clear();
      setReviewConflict(false);
      setDraftNotice("");
      setSuggestionsByMessageId({});
      setLoadedSuggestionIds({});
      setStaleSuggestionNotice({});
      setFocusedProposalId(null);
      await refreshSnapshot(snapshot.session_id);
    } catch (err) {
      handleApiError(err, snapshot.session_id);
    } finally {
      setReanalyzing(false);
    }
  };

  const handleLoadSuggestionIntoEdit = (
    messageId: string,
    suggestion: DraftSuggestion & { revision?: string; draftAtRequest?: string },
  ) => {
    const existing = allProposals.find((p) => p.id === suggestion.proposal_id);
    const staged = Boolean(
      suggestion.proposal && !snapshot?.proposals.some((p) => p.id === suggestion.proposal_id),
    );
    const editedSinceRequest =
      suggestion.draftAtRequest !== undefined &&
      reviewDraftsRef.current[suggestion.proposal_id]?.text !== suggestion.draftAtRequest;
    if (
      (existing && !staged && existing.proposed !== suggestion.proposed_at_request) ||
      (suggestion.revision && snapshot?.revision && suggestion.revision !== snapshot.revision) ||
      editedSinceRequest
    ) {
      setStaleSuggestionNotice((prev) => ({
        ...prev,
        [messageId]:
          "This proposal changed since this suggestion was drafted. Ask for a fresh revision before loading.",
      }));
      return;
    }
    if (staged && suggestion.proposal) {
      setStagedAdditions((prev) =>
        prev.some((p) => p.id === suggestion.proposal!.id)
          ? prev.map((p) => (p.id === suggestion.proposal!.id ? suggestion.proposal! : p))
          : [...prev, suggestion.proposal!],
      );
    }
    const baseProposed =
      (staged ? suggestion.proposal?.proposed : existing?.proposed) ??
      suggestion.proposed_at_request;
    handleReviewDraftsChange({
      ...reviewDraftsRef.current,
      [suggestion.proposal_id]: {
        action: "edit",
        text: suggestion.text,
        proposedAtDraft: baseProposed,
        issues: suggestion.issues,
      },
    });
    setLoadedSuggestionIds((prev) => ({ ...prev, [messageId]: true }));
    setStaleSuggestionNotice((prev) => {
      const next = { ...prev };
      delete next[messageId];
      return next;
    });
    openProposal(suggestion.proposal_id);
  };

  const handleSendMessage = async (e: FormEvent) => {
    e.preventDefault();
    if (!snapshot || !chatInput.trim() || snapshot.status === "running") return;
    const text = chatInput.trim();

    if (/^\/reanalyze\b/i.test(text)) {
      const rest = text.replace(/^\/reanalyze\b/i, "").trim();
      setChatInput("");
      openReanalyzeDialog(rest || undefined);
      return;
    }

    const targetSessionId = snapshot.session_id;
    const previousStatus = snapshot.status;
    const optimisticId = `local-user-${Date.now()}`;
    const scopedProposalId = focusedProposalId ?? undefined;
    setChatInput("");
    setSendingMessage(true);
    setErrorBanner(null);
    const optimistic: ChatMessage = { id: optimisticId, role: "user", content: text };

    const useAskEndpoint =
      snapshot.status === "review" ||
      (snapshot.status === "idle" && snapshot.reviewed) ||
      Boolean(scopedProposalId);

    if (useAskEndpoint) {
      setSnapshot((prev) => (prev ? { ...prev, messages: [...prev.messages, optimistic] } : prev));
      try {
        const draftAtRequest = scopedProposalId
          ? reviewDraftsRef.current[scopedProposalId]?.text
          : undefined;
        const res = await askSession(targetSessionId, {
          content: text,
          proposal_id: scopedProposalId,
          draft_text: draftAtRequest,
        });
        setFocusedProposalId(null);
        setSnapshot((prev) => {
          if (!prev) return prev;
          const hasReply = prev.messages.some((m) => m.id === res.message.id);
          return hasReply ? prev : { ...prev, messages: [...prev.messages, res.message] };
        });
        if (res.suggestion) {
          setSuggestionsByMessageId((prev) => ({
            ...prev,
            [res.message.id]: { ...res.suggestion!, revision: res.revision, draftAtRequest },
          }));
        }
      } catch (err) {
        setSnapshot((prev) =>
          prev
            ? {
                ...prev,
                status: previousStatus,
                messages: prev.messages.filter((m) => m.id !== optimisticId),
              }
            : prev,
        );
        setChatInput(text);
        handleApiError(err, targetSessionId);
        void refreshSnapshot(targetSessionId);
      } finally {
        setSendingMessage(false);
      }
      return;
    }

    setSnapshot((prev) =>
      prev ? { ...prev, status: "running", messages: [...prev.messages, optimistic] } : prev,
    );
    try {
      await sendMessage(targetSessionId, { content: text });
    } catch (err) {
      setSnapshot((prev) =>
        prev
          ? {
              ...prev,
              status: previousStatus,
              messages: prev.messages.filter((m) => m.id !== optimisticId),
            }
          : prev,
      );
      setChatInput(text);
      handleApiError(err, targetSessionId);
      void refreshSnapshot(targetSessionId);
    } finally {
      setSendingMessage(false);
    }
  };

  const handleSubmitReview = async (decisions: Record<string, Decision>) => {
    if (!snapshot || reviewConflict || sendingMessage) return;
    setSubmittingReview(true);
    setErrorBanner(null);
    try {
      await submitReview(snapshot.session_id, {
        decisions,
        additions: stagedAdditions.length > 0 ? stagedAdditions : undefined,
        expected_revision: draftBaseRevisionRef.current ?? snapshot.revision,
      });
      dirtyDraftIdsRef.current.clear();
      draftBaseRevisionRef.current = null;
      setStagedAdditions([]);
      const updated = await refreshSnapshot(snapshot.session_id);
      if (updated) setActiveTab("export");
    } catch (err) {
      handleApiError(err, snapshot.session_id);
      if (err instanceof HttpError && err.detail === "stale_review") {
        setReviewConflict(true);
        await refreshSnapshot(snapshot.session_id);
      }
    } finally {
      setSubmittingReview(false);
    }
  };

  const handleAmendReview = async (decisions: Record<string, Decision>) => {
    if (!snapshot || reviewConflict || sendingMessage) return;
    setAmendingReview(true);
    setErrorBanner(null);
    try {
      const updated = await amendSession(snapshot.session_id, {
        decisions,
        additions: stagedAdditions.length > 0 ? stagedAdditions : undefined,
        expected_revision: draftBaseRevisionRef.current ?? snapshot.revision,
      });
      dirtyDraftIdsRef.current.clear();
      draftBaseRevisionRef.current = null;
      setStagedAdditions([]);
      setSnapshot(updated);
      setReviewDrafts(reconcileReviewDrafts(updated.proposals, updated.decisions, {}));
      setActiveTab("export");
    } catch (err) {
      handleApiError(err, snapshot.session_id);
      if (err instanceof HttpError && err.detail === "stale_review") {
        setReviewConflict(true);
        await refreshSnapshot(snapshot.session_id);
      }
    } finally {
      setAmendingReview(false);
    }
  };

  const handleResumeInterrupted = async () => {
    if (!snapshot) return;
    setResumingRun(true);
    setErrorBanner(null);
    try {
      await resumeSession(snapshot.session_id);
      await refreshSnapshot(snapshot.session_id);
    } catch (err) {
      handleApiError(err, snapshot.session_id);
    } finally {
      setResumingRun(false);
    }
  };

  const handleSimulateState = (targetStatus: SessionStatus) => {
    if (!snapshot) return;
    const reports = Object.keys(snapshot.reports).length ? snapshot.reports : MOCK_REPORTS;
    const gap = snapshot.gap ?? MOCK_GAP_REPORT;
    const proposals = snapshot.proposals.length ? snapshot.proposals : MOCK_PROPOSALS;
    updateMockSnapshotState((prev) => ({ ...prev, status: targetStatus, reports, gap, proposals }));
    setSnapshot({ ...snapshot, status: targetStatus, reports, gap, proposals });
    setReviewDrafts((prev) => reconcileReviewDrafts(proposals, snapshot.decisions, prev));
    if (targetStatus === "review") setActiveTab("review");
  };

  const openStaff = (node: StaffNode) => {
    setSelectedStaff(node);
    setActiveTab("score");
  };

  const openProposal = (id: string) => {
    setActiveTab("review");
    requestAnimationFrame(() => {
      const el = document.getElementById(`proposal-${id}`);
      el?.scrollIntoView({ block: "start" });
      el?.focus({ preventScroll: true });
    });
  };

  const handleAskAboutProposal = (proposal: Proposal) => {
    setFocusedProposalId(proposal.id);
    requestAnimationFrame(() => {
      const inputEl = document.getElementById("concierge-chat-input");
      inputEl?.focus();
    });
  };

  // Follow whatever is playing until the user picks a staff themselves.
  const liveStaff = STAVES.find(
    (s) => s.node !== "concierge" && staffStatus(score, s.node) === "running",
  );
  const shownStaff: StaffNode = selectedStaff ?? liveStaff?.node ?? "job_analyst";
  const playing = nowPlaying(score);
  const focusedProposal = focusedProposalId
    ? allProposals.find((p) => p.id === focusedProposalId)
    : undefined;

  return (
    <div className="app">
      <header className="shell no-print">
        <a
          className="wordmark"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            navigateToSession(null);
          }}
        >
          Agentic Resume
        </a>
        {snapshot ? (
          <p className="shell-role">
            <strong>{snapshot.target.title}</strong>
            {snapshot.target.company ? <span> · {snapshot.target.company}</span> : null}
          </p>
        ) : null}

        {snapshot ? (
          <nav className="shell-tabs" aria-label="Session views">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                className="shell-tab"
                aria-current={activeTab === t.id ? "page" : undefined}
                onClick={() => setActiveTab(t.id)}
              >
                {t.label}
                {t.id === "review" && allProposals.length ? (
                  <span className="shell-tab-count">{allProposals.length}</span>
                ) : null}
              </button>
            ))}
          </nav>
        ) : null}

        <div className="shell-actions">
          {snapshot ? (
            <p className={`shell-status shell-status-${snapshot.status}`} aria-live="polite">
              {snapshot.status === "running" ? (
                <span className="live-dot" aria-hidden="true" />
              ) : null}
              {snapshot.status === "running" && playing
                ? playing
                : snapshot.status === "idle" && snapshot.reviewed
                  ? "Finished"
                  : STATUS_LINE[snapshot.status]}
            </p>
          ) : null}
          {mockActive || import.meta.env.DEV ? (
            <button type="button" className="shell-btn" onClick={handleToggleMockMode}>
              {mockActive ? "Demo data on" : "Demo data off"}
            </button>
          ) : null}
          <button
            type="button"
            className="shell-btn"
            aria-expanded={showPasscode}
            onClick={() => setShowPasscode((v) => !v)}
          >
            <IconKey width={15} height={15} aria-hidden="true" />
            {passcode ? "Passcode set" : "Passcode"}
          </button>
          {sessionId ? (
            <button type="button" className="shell-btn" onClick={() => navigateToSession(null)}>
              New session
            </button>
          ) : null}
        </div>
      </header>

      {showPasscode ? (
        <form
          className="strip passcode no-print"
          onSubmit={handleSavePasscode}
          aria-label="Demo passcode"
        >
          <label htmlFor="demo-passcode-input">Demo passcode</label>
          <input
            id="demo-passcode-input"
            type="password"
            className="field"
            autoComplete="off"
            placeholder="The passcode you were given"
            value={passcode}
            onChange={(e) => setPasscodeState(e.target.value)}
          />
          <button type="submit" className="btn btn-primary">
            Save passcode
          </button>
          <button type="button" className="btn" onClick={() => setShowPasscode(false)}>
            Close
          </button>
        </form>
      ) : null}

      {errorBanner ? (
        <div className="strip strip-error no-print" role="alert">
          <span>{errorBanner.message}</span>
          {errorBanner.code === "budget_exceeded" && !mockActive ? (
            <button type="button" className="btn" onClick={handleToggleMockMode}>
              Explore with demo data
            </button>
          ) : null}
          {errorBanner.code === "bad_passcode" ? (
            <button type="button" className="btn" onClick={() => setShowPasscode(true)}>
              Enter passcode
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-quiet"
            aria-label="Dismiss"
            onClick={() => setErrorBanner(null)}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {showReanalyzeConfirm && snapshot ? (
        <form
          className="reanalyze-box no-print"
          onSubmit={(e) => void handleConfirmReanalyze(e)}
          aria-label="Confirm fresh analysis"
        >
          <div className="reanalyze-head">
            <strong>Start a fresh analysis?</strong>
            <p>
              Running a fresh analysis replaces your current research reports, gap analysis, rewrite
              proposals, and saved review decisions.
            </p>
          </div>
          <div className="reanalyze-fields">
            <label>
              Target role title
              <input
                type="text"
                className="field"
                required
                value={reanalyzeTitle}
                onChange={(e) => setReanalyzeTitle(e.target.value)}
              />
            </label>
            <label>
              Company (optional)
              <input
                type="text"
                className="field"
                value={reanalyzeCompany}
                onChange={(e) => setReanalyzeCompany(e.target.value)}
              />
            </label>
            <label className="reanalyze-full">
              Posting URL (optional)
              <input
                type="url"
                className="field"
                value={reanalyzeJobUrl}
                onChange={(e) => setReanalyzeJobUrl(e.target.value)}
              />
            </label>
            <label className="reanalyze-full">
              Job description (optional)
              <textarea
                className="field"
                rows={2}
                value={reanalyzeJobText}
                onChange={(e) => setReanalyzeJobText(e.target.value)}
              />
            </label>
            <label className="reanalyze-full">
              Level, region or other notes (optional)
              <input
                type="text"
                className="field"
                value={reanalyzeNotes}
                onChange={(e) => setReanalyzeNotes(e.target.value)}
              />
            </label>
          </div>
          <div className="row">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={reanalyzing || !reanalyzeTitle.trim()}
            >
              {reanalyzing ? "Starting fresh analysis…" : "Confirm & Start Fresh Analysis"}
            </button>
            <button type="button" className="btn" onClick={() => setShowReanalyzeConfirm(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      <main className="stage">
        {!sessionId ? (
          <StartScreen
            onSessionCreated={(id) => navigateToSession(id)}
            onOpenDemoSession={() => navigateToSession("demo")}
            onApiError={(err) => handleApiError(err)}
          />
        ) : notFoundSessionId ? (
          <section className="lost" role="alert" aria-labelledby="not-found-title">
            <h1 id="not-found-title">Session not found</h1>
            <p>
              There is no session <code>{notFoundSessionId}</code>. The link may be incomplete, or
              the session was removed.
            </p>
            <div className="row">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => navigateToSession(null)}
              >
                Start a new session
              </button>
              {mockActive ? (
                <button type="button" className="btn" onClick={() => navigateToSession("demo")}>
                  Open the demo session
                </button>
              ) : null}
            </div>
          </section>
        ) : loadingSession && !snapshot ? (
          <p className="loading">Opening the session…</p>
        ) : snapshot ? (
          <div className="workspace">
            <aside className="chat no-print" aria-label="Chat with the assistant">
              <h2 className="col-title">Assistant</h2>
              <div className="chat-log" role="log" aria-live="polite">
                {snapshot.messages.map((m) => {
                  const suggestion = suggestionsByMessageId[m.id];
                  const isLoaded = Boolean(loadedSuggestionIds[m.id]);
                  const staleNotice = staleSuggestionNotice[m.id];
                  const targetProposal = suggestion
                    ? (allProposals.find((p) => p.id === suggestion.proposal_id) ??
                      suggestion.proposal ??
                      undefined)
                    : undefined;
                  const isStale =
                    suggestion &&
                    ((suggestion.revision &&
                      snapshot.revision &&
                      suggestion.revision !== snapshot.revision) ||
                      (targetProposal &&
                        !suggestion.proposal &&
                        targetProposal.proposed !== suggestion.proposed_at_request));

                  return (
                    <div key={m.id} className={`msg msg-${m.role}`}>
                      <span className="msg-who">
                        {m.role === "assistant" ? "Assistant" : "You"}
                      </span>
                      <ChatText text={m.content} />
                      {suggestion ? (
                        <div
                          className="suggestion-card"
                          aria-label={`Draft suggestion for ${suggestion.proposal_id}`}
                        >
                          <div className="suggestion-head">
                            <strong>
                              Draft suggestion ·{" "}
                              {targetProposal
                                ? targetName(targetProposal.target, snapshot.profile)
                                : suggestion.proposal_id}
                            </strong>
                            {suggestion.issues.length > 0 ? (
                              <span className="verdict verdict-flagged">
                                <IconAlert width={13} height={13} aria-hidden="true" />
                                Flagged ({suggestion.issues.length})
                              </span>
                            ) : (
                              <span className="verdict">
                                <IconCheck width={13} height={13} aria-hidden="true" />
                                Critic Checked
                              </span>
                            )}
                          </div>
                          <p className="suggestion-text">{suggestion.text}</p>
                          {suggestion.issues.length > 0 ? (
                            <ul className="issues" aria-label="Suggestion issues">
                              {suggestion.issues.map((issue, idx) => (
                                <li key={idx}>{issue}</li>
                              ))}
                            </ul>
                          ) : null}
                          {staleNotice || isStale ? (
                            <p className="ev-note" role="status">
                              {staleNotice ??
                                "Proposal changed since this draft was created. Ask for a fresh revision."}
                            </p>
                          ) : null}
                          <div className="row">
                            <button
                              type="button"
                              className="btn btn-small btn-primary"
                              disabled={Boolean(isStale)}
                              onClick={() => handleLoadSuggestionIntoEdit(m.id, suggestion)}
                            >
                              {isLoaded ? "Loaded into Edit" : "Load into Edit"}
                            </button>
                            <button
                              type="button"
                              className="text-link"
                              onClick={() => openProposal(suggestion.proposal_id)}
                            >
                              View proposal
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
                {streamingTokens ? (
                  <div className="msg msg-assistant msg-streaming">
                    <span className="msg-who">Assistant</span>
                    <ChatText text={streamingTokens} />
                  </div>
                ) : null}
              </div>

              {snapshot.status === "review" ? (
                <div className="chat-hold" role="status">
                  <strong>Review in progress — ask questions or request draft edits</strong>
                  <p>
                    Questions and draft suggestions stay in your local review buffer until you
                    submit{" "}
                    <button
                      type="button"
                      className="text-link"
                      onClick={() => setActiveTab("review")}
                    >
                      Open the review
                    </button>
                  </p>
                </div>
              ) : null}

              <form className="composer" onSubmit={(e) => void handleSendMessage(e)}>
                {focusedProposalId ? (
                  <div className="ask-chip">
                    <span>
                      Asking about:{" "}
                      <strong>
                        {focusedProposal
                          ? targetName(focusedProposal.target, snapshot.profile)
                          : focusedProposalId}
                      </strong>
                    </span>
                    <button
                      type="button"
                      className="text-link"
                      onClick={() => setFocusedProposalId(null)}
                    >
                      Clear
                    </button>
                  </div>
                ) : null}
                <label htmlFor="concierge-chat-input" className="sr-only">
                  Message the assistant
                </label>
                <textarea
                  id="concierge-chat-input"
                  className="field composer-input"
                  rows={3}
                  placeholder={
                    focusedProposal
                      ? `Ask a question or request an edit for ${targetName(focusedProposal.target, snapshot.profile)}…`
                      : "Ask why a line changed, or ask for a revision…"
                  }
                  value={chatInput}
                  disabled={sendingMessage || snapshot.status === "running"}
                  onChange={(e) => setChatInput(e.target.value)}
                />
                <button
                  type="submit"
                  className="btn btn-primary composer-send"
                  disabled={sendingMessage || snapshot.status === "running" || !chatInput.trim()}
                >
                  <IconSend width={15} height={15} aria-hidden="true" />
                  Send
                </button>
              </form>

              {mockActive ? (
                <div className="sim" aria-label="Demo states">
                  <span>Demo states</span>
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => handleSimulateState("review")}
                  >
                    Review gate
                  </button>
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => handleSimulateState("interrupted")}
                  >
                    Interrupted
                  </button>
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => handleSimulateState("failed")}
                  >
                    Failed
                  </button>
                </div>
              ) : null}
            </aside>

            <section className="center" aria-label={TABS.find((t) => t.id === activeTab)?.label}>
              {activeTab === "score" ? (
                <ScorePanel
                  score={score}
                  reports={snapshot.reports}
                  gap={snapshot.gap}
                  proposals={allProposals}
                  profile={snapshot.profile}
                  selected={shownStaff}
                  onSelect={(node) => setSelectedStaff(node)}
                  onOpenProposal={openProposal}
                />
              ) : null}
              {activeTab === "review" ? (
                <>
                  {reviewConflict ? (
                    <div className="cue cue-warn" role="alert">
                      <strong>Saved decisions changed</strong>
                      <p>
                        {draftNotice ||
                          "Your drafts are preserved. Compare them with the latest saved decisions before choosing which to keep."}
                      </p>
                      <div className="row">
                        <button
                          type="button"
                          className="btn"
                          onClick={() => reconcileConflict(true)}
                        >
                          Keep my edited drafts on the latest version
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => reconcileConflict(false)}
                        >
                          Reload saved decisions
                        </button>
                      </div>
                    </div>
                  ) : null}
                  <ReviewPanel
                    proposals={allProposals}
                    profile={snapshot.profile}
                    linkedinGuidance={snapshot.linkedin_guidance}
                    locked={reviewConflict || sendingMessage}
                    initialDecisions={snapshot.decisions}
                    drafts={reviewDrafts}
                    onDraftsChange={handleReviewDraftsChange}
                    isReviewPending={snapshot.status === "review"}
                    isReviewed={snapshot.reviewed}
                    submitting={submittingReview}
                    amending={amendingReview}
                    onOpenStaff={openStaff}
                    onAskAboutProposal={handleAskAboutProposal}
                    onSubmitReview={handleSubmitReview}
                    onAmendReview={handleAmendReview}
                  />
                </>
              ) : null}
              {activeTab === "export" ? (
                <ExportPanel snapshot={snapshot} onApiError={(err) => handleApiError(err)} />
              ) : null}
            </section>

            <ProgramNote
              snapshot={snapshot}
              score={score}
              onSelect={openStaff}
              onOpenReview={() => setActiveTab("review")}
              onOpenExport={() => setActiveTab("export")}
              onResume={() => void handleResumeInterrupted()}
              onOpenReanalyze={() => openReanalyzeDialog()}
              resuming={resumingRun}
              exportOpen={activeTab === "export"}
            />
          </div>
        ) : null}
      </main>
    </div>
  );
}
