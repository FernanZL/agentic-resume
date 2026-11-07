/**
 * The app shell: start screen and /s/<id> routing, the session workspace (chat, the
 * score with review and export, and the program note), the live event stream, the
 * passcode gate and the session states (review, interrupted, failed, budget, 404).
 */

import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  type ChatMessage,
  type Decision,
  type Event,
  type ReviewDraftEntry,
  type SessionSnapshot,
  type SessionStatus,
  activateDemoSessionSnapshot,
  formatRunFailedError,
  getSession,
  isMockMode,
  parseSessionIdFromPath,
  reconcileReviewDrafts,
  resumeSession,
  sendMessage,
  setMockMode,
  submitReview,
  updateMockSnapshotState,
} from "./api";
import { ChatText } from "./components/ChatText";
import { ExportPanel } from "./components/ExportPanel";
import { IconKey, IconSend } from "./components/Icons";
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

  const [activeTab, setActiveTab] = useState<WorkspaceTab>("score");
  const [chatInput, setChatInput] = useState("");
  const [sendingMessage, setSendingMessage] = useState(false);
  const [submittingReview, setSubmittingReview] = useState(false);
  const [resumingRun, setResumingRun] = useState(false);

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
        setReviewDrafts((prev) => reconcileReviewDrafts(snap.proposals, snap.decisions, prev));
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

  const handleSendMessage = async (e: FormEvent) => {
    e.preventDefault();
    if (!snapshot || !chatInput.trim() || snapshot.status === "review") return;
    const text = chatInput.trim();
    const targetSessionId = snapshot.session_id;
    const previousStatus = snapshot.status;
    const optimisticId = `local-user-${Date.now()}`;
    setChatInput("");
    setSendingMessage(true);
    setErrorBanner(null);
    const optimistic: ChatMessage = { id: optimisticId, role: "user", content: text };
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
    if (!snapshot) return;
    setSubmittingReview(true);
    setErrorBanner(null);
    try {
      await submitReview(snapshot.session_id, { decisions });
      const updated = await refreshSnapshot(snapshot.session_id);
      if (updated) setActiveTab("export");
    } catch (err) {
      handleApiError(err, snapshot.session_id);
    } finally {
      setSubmittingReview(false);
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

  // Follow whatever is playing until the user picks a staff themselves.
  const liveStaff = STAVES.find(
    (s) => s.node !== "concierge" && staffStatus(score, s.node) === "running",
  );
  const shownStaff: StaffNode = selectedStaff ?? liveStaff?.node ?? "job_analyst";
  const playing = nowPlaying(score);

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
                {t.id === "review" && snapshot.proposals.length ? (
                  <span className="shell-tab-count">{snapshot.proposals.length}</span>
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
                {snapshot.messages.map((m) => (
                  <div key={m.id} className={`msg msg-${m.role}`}>
                    <span className="msg-who">{m.role === "assistant" ? "Assistant" : "You"}</span>
                    <ChatText text={m.content} />
                  </div>
                ))}
                {streamingTokens ? (
                  <div className="msg msg-assistant msg-streaming">
                    <span className="msg-who">Assistant</span>
                    <ChatText text={streamingTokens} />
                  </div>
                ) : null}
              </div>

              {snapshot.status === "review" ? (
                <div className="chat-hold" role="status">
                  <strong>Chat is paused for your review</strong>
                  <p>
                    Decide on the proposals first.{" "}
                    <button
                      type="button"
                      className="text-link"
                      onClick={() => setActiveTab("review")}
                    >
                      Open the review
                    </button>
                  </p>
                </div>
              ) : (
                <form className="composer" onSubmit={(e) => void handleSendMessage(e)}>
                  <label htmlFor="concierge-chat-input" className="sr-only">
                    Message the assistant
                  </label>
                  <textarea
                    id="concierge-chat-input"
                    className="field composer-input"
                    rows={3}
                    placeholder="Ask why a line changed, or ask for a revision…"
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
              )}

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
                  proposals={snapshot.proposals}
                  selected={shownStaff}
                  onSelect={(node) => setSelectedStaff(node)}
                  onOpenProposal={openProposal}
                />
              ) : null}
              {activeTab === "review" ? (
                <ReviewPanel
                  proposals={snapshot.proposals}
                  initialDecisions={snapshot.decisions}
                  drafts={reviewDrafts}
                  onDraftsChange={setReviewDrafts}
                  isReviewPending={snapshot.status === "review"}
                  submitting={submittingReview}
                  onOpenStaff={openStaff}
                  onSubmitReview={handleSubmitReview}
                />
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
              resuming={resumingRun}
              exportOpen={activeTab === "export"}
            />
          </div>
        ) : null}
      </main>
    </div>
  );
}
