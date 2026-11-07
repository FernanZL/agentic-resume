/**
 * Main application shell: manages Start flow, /s/<session_id> URL routing,
 * Split-Pane Session Workspace, SSE live telemetry, Passcode gate,
 * Budget/Interrupted/404 states, session-level Review drafts, and Export.
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
import { ExportPanel } from "./components/ExportPanel";
import {
  IconAlert,
  IconCheck,
  IconKey,
  IconRefresh,
  IconSend,
  IconSpark,
} from "./components/Icons";
import { ReviewPanel } from "./components/ReviewPanel";
import { StartScreen } from "./components/StartScreen";
import { type NodeTelemetry, TimelinePanel } from "./components/TimelinePanel";
import { HttpError, getStoredPasscode, setStoredPasscode } from "./connection";
import { connectSessionEvents } from "./events";
import { MOCK_GAP_REPORT, MOCK_PROPOSALS, MOCK_REPORTS } from "./mock/fixtures";

type WorkspaceTab = "timeline" | "review" | "export";

function createInitialNodes(): Record<string, NodeTelemetry> {
  return {
    intake: {
      node: "intake",
      title: "1. Intake & Safety Screen",
      stage: "intake",
      status: "waiting",
      label: "Parse resume, LinkedIn export, and screen untrusted text",
      tools: [],
    },
    job_analyst: {
      node: "job_analyst",
      title: "Job Analyst",
      stage: "research",
      status: "waiting",
      label: "Extract must-haves, seniority rubric, and exact ATS terms",
      tools: [],
    },
    company_researcher: {
      node: "company_researcher",
      title: "Company Researcher",
      stage: "research",
      status: "waiting",
      label: "Investigate engineering stack, products, and culture",
      tools: [],
    },
    market_analyst: {
      node: "market_analyst",
      title: "Market Analyst",
      stage: "research",
      status: "waiting",
      label: "Benchmark role title variants and level signals",
      tools: [],
    },
    linkedin_auditor: {
      node: "linkedin_auditor",
      title: "LinkedIn Auditor",
      stage: "research",
      status: "waiting",
      label: "Audit headline, About, and experience consistency",
      tools: [],
    },
    gap_analysis: {
      node: "gap_analysis",
      title: "2. ATS & Structural Gap Analysis",
      stage: "gap",
      status: "waiting",
      label: "Deterministic keyword matrix + LLM priority rubric",
      tools: [],
    },
    resume_writer: {
      node: "resume_writer",
      title: "Resume Writer",
      stage: "write",
      status: "waiting",
      label: "Draft coherent grounded rewrites across resume sections",
      tools: [],
    },
    linkedin_writer: {
      node: "linkedin_writer",
      title: "LinkedIn Writer",
      stage: "write",
      status: "waiting",
      label: "Draft aligned LinkedIn Headline and About narrative",
      tools: [],
    },
    critic: {
      node: "critic",
      title: "3. Anti-Fabrication Critic",
      stage: "critic",
      status: "waiting",
      label: "Verify every number and claim against source profile",
      tools: [],
    },
    review: {
      node: "review",
      title: "4. Human Review Gate",
      stage: "review",
      status: "waiting",
      label: "Pause for accept / edit / reject decisions",
      tools: [],
    },
    finalize: {
      node: "finalize",
      title: "5. Finalize Profile",
      stage: "finalize",
      status: "waiting",
      label: "Apply approved rewrites for DOCX, Markdown & PDF",
      tools: [],
    },
  };
}

export function App() {
  const [sessionId, setSessionId] = useState<string | null>(() =>
    parseSessionIdFromPath(window.location.pathname),
  );
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [loadingSession, setLoadingSession] = useState(false);
  const [notFoundSessionId, setNotFoundSessionId] = useState<string | null>(null);

  const [nodes, setNodes] = useState<Record<string, NodeTelemetry>>(createInitialNodes);
  const [criticRounds, setCriticRounds] = useState(0);
  const [flaggedCount, setFlaggedCount] = useState(0);
  const [streamingTokens, setStreamingTokens] = useState("");
  const [reviewDrafts, setReviewDrafts] = useState<Record<string, ReviewDraftEntry>>({});

  const [activeTab, setActiveTab] = useState<WorkspaceTab>("timeline");
  const [chatInput, setChatInput] = useState("");
  const [sendingMessage, setSendingMessage] = useState(false);
  const [submittingReview, setSubmittingReview] = useState(false);
  const [resumingRun, setResumingRun] = useState(false);

  const [passcode, setPasscodeState] = useState<string>(() => getStoredPasscode());
  const [showPasscodeModal, setShowPasscodeModal] = useState(false);
  const [mockActive, setMockActive] = useState<boolean>(() => isMockMode());

  const [errorBanner, setErrorBanner] = useState<{
    code: "bad_passcode" | "budget_exceeded" | "generic";
    message: string;
  } | null>(null);

  const refreshDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const snapshotReqGenRef = useRef(0);
  const snapshotAbortRef = useRef<AbortController | null>(null);
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
    if (!nextId) {
      setSessionId(null);
      setSnapshot(null);
      setNodes(createInitialNodes());
      setCriticRounds(0);
      setFlaggedCount(0);
      setActiveTab("timeline");
      return;
    }
    if (nextId === "demo" && isMockMode()) {
      activateDemoSessionSnapshot();
      setCriticRounds(1);
      setFlaggedCount(1);
      setActiveTab("review");
    } else {
      setCriticRounds(0);
      setFlaggedCount(0);
      setActiveTab("timeline");
    }
    setSnapshot(null);
    setNodes(createInitialNodes());
    setSessionId(nextId);
  }, []);

  useEffect(() => {
    const onPopState = () => {
      const idFromPath = parseSessionIdFromPath(window.location.pathname);
      navigateToSession(idFromPath, false);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [navigateToSession]);

  const handleApiError = useCallback(
    (err: unknown, targetSessionId?: string) => {
      if (err instanceof Error && err.name === "AbortError") {
        return;
      }
      if (err instanceof HttpError) {
        if (err.status === 404 || err.detail === "session_not_found") {
          setNotFoundSessionId(targetSessionId ?? sessionId ?? "unknown");
          setSnapshot(null);
          return;
        }
        if (err.status === 401 || err.detail === "bad_passcode") {
          setErrorBanner({
            code: "bad_passcode",
            message:
              "Authentication required (401 bad_passcode): enter the demo passcode to authorize POST requests.",
          });
          setShowPasscodeModal(true);
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
          message: `API Error (${err.status}): ${err.detail}`,
        });
        return;
      }
      const msg =
        err instanceof Error ? err.message : "Unexpected error communicating with server.";
      setErrorBanner({ code: "generic", message: msg });
    },
    [sessionId],
  );

  const hydrateNodesFromSnapshot = useCallback((snap: SessionSnapshot) => {
    setNodes((prev) => {
      const next = { ...prev };
      (["job", "company", "market", "linkedin"] as const).forEach((kind) => {
        const nodeMap: Record<string, string> = {
          job: "job_analyst",
          company: "company_researcher",
          market: "market_analyst",
          linkedin: "linkedin_auditor",
        };
        const nodeKey = nodeMap[kind];
        if (snap.reports[kind] && next[nodeKey]) {
          next[nodeKey] = {
            ...next[nodeKey],
            status: "done",
          };
          next.intake = { ...next.intake, status: "done" };
        }
      });
      if (snap.gap) {
        next.gap_analysis = { ...next.gap_analysis, status: "done" };
      }
      if (snap.proposals.length > 0) {
        next.resume_writer = { ...next.resume_writer, status: "done" };
        next.linkedin_writer = { ...next.linkedin_writer, status: "done" };
        next.critic = { ...next.critic, status: "done" };
      }
      if (snap.status === "review") {
        next.review = { ...next.review, status: "running" };
      } else if (
        snap.reviewed ||
        (snap.status === "idle" && Object.keys(snap.decisions).length > 0)
      ) {
        next.review = { ...next.review, status: "done" };
        next.finalize = { ...next.finalize, status: "done" };
      }
      return next;
    });
    const flagged = snap.proposals.filter((p) => p.status === "flagged").length;
    if (snap.proposals.length > 0) {
      setCriticRounds((r) => (r > 0 ? r : 1));
      setFlaggedCount(flagged);
    }
    setReviewDrafts((prev) => reconcileReviewDrafts(snap.proposals, snap.decisions, prev));
  }, []);

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
        hydrateNodesFromSnapshot(snap);
        if (snap.status === "review") {
          setActiveTab("review");
        }
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
    [handleApiError, hydrateNodesFromSnapshot],
  );

  const scheduleDebouncedRefresh = useCallback(
    (id: string) => {
      if (refreshDebounceRef.current !== null) {
        clearTimeout(refreshDebounceRef.current);
      }
      refreshDebounceRef.current = setTimeout(() => {
        refreshDebounceRef.current = null;
        void refreshSnapshot(id);
      }, 300);
    },
    [refreshSnapshot],
  );

  const handleSseEvent = useCallback(
    (ev: Event) => {
      if (ev.type === "node_started" && ev.node) {
        const label = typeof ev.data.label === "string" ? ev.data.label : undefined;
        setNodes((prev) => {
          const existing = prev[ev.node];
          if (!existing) return prev;
          return {
            ...prev,
            [ev.node]: {
              ...existing,
              status: "running",
              label: label ?? existing.label,
            },
          };
        });
      } else if (ev.type === "node_finished" && ev.node) {
        const label = typeof ev.data.label === "string" ? ev.data.label : undefined;
        const seconds = typeof ev.data.seconds === "number" ? ev.data.seconds : undefined;
        setNodes((prev) => {
          const existing = prev[ev.node];
          if (!existing) return prev;
          return {
            ...prev,
            [ev.node]: {
              ...existing,
              status: "done",
              label: label ?? existing.label,
              seconds: seconds ?? existing.seconds,
            },
          };
        });
      } else if (ev.type === "tool_called" && ev.node) {
        const toolName = String(ev.data.tool ?? "tool");
        const summary = String(ev.data.summary ?? "");
        setNodes((prev) => {
          const existing = prev[ev.node];
          if (!existing) return prev;
          return {
            ...prev,
            [ev.node]: {
              ...existing,
              tools: [...existing.tools, { tool: toolName, summary }],
            },
          };
        });
      } else if (ev.type === "token") {
        const chunk = typeof ev.data.text === "string" ? ev.data.text : "";
        if (chunk) {
          setStreamingTokens((prev) => prev + chunk);
        }
      } else if (ev.type === "message") {
        setStreamingTokens("");
        const msg = ev.data as unknown as ChatMessage;
        if (msg?.id && msg?.content) {
          setSnapshot((prev) => {
            if (!prev) return prev;
            if (prev.messages.some((m) => m.id === msg.id)) return prev;
            return { ...prev, messages: [...prev.messages, msg] };
          });
        }
      } else if (
        ev.type === "report_ready" ||
        ev.type === "gap_ready" ||
        ev.type === "proposals_ready" ||
        ev.type === "critique"
      ) {
        if (ev.type === "critique") {
          const round = typeof ev.data.round === "number" ? ev.data.round : 1;
          const flaggedIds = Array.isArray(ev.data.flagged_ids) ? ev.data.flagged_ids : [];
          setCriticRounds(round);
          setFlaggedCount(flaggedIds.length);
        }
        const targetSessionId = ev.session_id || sessionId;
        if (targetSessionId) {
          scheduleDebouncedRefresh(targetSessionId);
        }
      } else if (ev.type === "review_required") {
        setSnapshot((prev) => (prev ? { ...prev, status: "review" } : prev));
        setActiveTab("review");
        const targetSessionId = ev.session_id || sessionId;
        if (targetSessionId) {
          void refreshSnapshot(targetSessionId);
        }
      } else if (ev.type === "run_completed") {
        setStreamingTokens("");
        const nextStatus = (ev.data.status as SessionStatus | undefined) ?? "idle";
        setSnapshot((prev) => (prev ? { ...prev, status: nextStatus } : prev));
        if (sessionId) {
          void refreshSnapshot(sessionId);
        }
      } else if (ev.type === "run_failed") {
        setStreamingTokens("");
        const rawCode = String(ev.data.error ?? "internal_error");
        setSnapshot((prev) => (prev ? { ...prev, status: "failed" } : prev));
        setErrorBanner({
          code: rawCode === "budget_exceeded" ? "budget_exceeded" : "generic",
          message: formatRunFailedError(rawCode),
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
        cleanupStream = connectSessionEvents(sessionId, snap.last_event_id, {
          onEvent: handleSseEvent,
        });
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
    setShowPasscodeModal(false);
    if (errorBanner?.code === "bad_passcode") {
      setErrorBanner(null);
    }
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

    const optimisticUserMsg: ChatMessage = {
      id: optimisticId,
      role: "user",
      content: text,
    };
    setSnapshot((prev) =>
      prev ? { ...prev, status: "running", messages: [...prev.messages, optimisticUserMsg] } : prev,
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
      if (updated) {
        setActiveTab("export");
      }
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
    const nextReports = Object.keys(snapshot.reports).length ? snapshot.reports : MOCK_REPORTS;
    const nextGap = snapshot.gap ?? MOCK_GAP_REPORT;
    const nextProposals = snapshot.proposals.length ? snapshot.proposals : MOCK_PROPOSALS;
    updateMockSnapshotState((prev) => ({
      ...prev,
      status: targetStatus,
      reports: nextReports,
      gap: nextGap,
      proposals: nextProposals,
    }));
    setSnapshot({
      ...snapshot,
      status: targetStatus,
      reports: nextReports,
      gap: nextGap,
      proposals: nextProposals,
    });
    setReviewDrafts((prev) => reconcileReviewDrafts(nextProposals, snapshot.decisions, prev));
    if (targetStatus === "review") {
      setActiveTab("review");
    }
  };

  return (
    <div className="app-frame">
      <header className="top-bar no-print">
        <div className="brand-cluster">
          <span className="brand-mark" aria-hidden="true">
            AR
          </span>
          <div>
            <span className="brand-title">Agentic Resume</span>
            <span className="brand-subtitle">Multi-Agent Career &amp; LinkedIn Workbench</span>
          </div>
        </div>

        {snapshot ? (
          <div className="session-context-bar" aria-label="Active session summary">
            <span className="context-role">
              <strong>{snapshot.target.title}</strong>
              {snapshot.target.company ? ` · ${snapshot.target.company}` : ""}
            </span>
            <span className={`status-pill status-${snapshot.status}`}>
              Status: {snapshot.status.toUpperCase()}
            </span>
            <span className="cost-pill" title="Cumulative OpenRouter spend for this session">
              ${snapshot.cost_usd.toFixed(4)}
            </span>
          </div>
        ) : null}

        <div className="top-bar-actions">
          <button
            type="button"
            className={`btn btn-small ${mockActive ? "btn-mock-on" : "btn-ghost"}`}
            onClick={handleToggleMockMode}
            title="Toggle scripted mock replay mode (VITE_MOCK)"
          >
            <IconSpark width={14} height={14} />
            <span>{mockActive ? "Mock Replay: ON" : "Live API Mode"}</span>
          </button>

          <button
            type="button"
            className="btn btn-small btn-ghost"
            onClick={() => setShowPasscodeModal((v) => !v)}
          >
            <IconKey width={14} height={14} />
            <span>{passcode ? "Passcode Set" : "Set Passcode"}</span>
          </button>

          {sessionId ? (
            <button
              type="button"
              className="btn btn-small btn-ghost"
              onClick={() => navigateToSession(null)}
            >
              New Session
            </button>
          ) : null}
        </div>
      </header>

      {showPasscodeModal ? (
        <div
          className="passcode-drawer no-print"
          role="dialog"
          aria-label="Configure Demo Passcode"
        >
          <form className="passcode-form" onSubmit={handleSavePasscode}>
            <label htmlFor="demo-passcode-input">
              Demo Passcode (sent via <code>X-Demo-Passcode</code> header on POST requests):
            </label>
            <input
              id="demo-passcode-input"
              type="password"
              className="input-text"
              placeholder="Enter passcode..."
              value={passcode}
              onChange={(e) => setPasscodeState(e.target.value)}
            />
            <button type="submit" className="btn btn-primary btn-small">
              Save Passcode
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-small"
              onClick={() => setShowPasscodeModal(false)}
            >
              Close
            </button>
          </form>
        </div>
      ) : null}

      {errorBanner ? (
        <div className="banner banner-error global-banner no-print" role="alert">
          <IconAlert width={18} height={18} />
          <div className="banner-content">
            <span>{errorBanner.message}</span>
            {errorBanner.code === "budget_exceeded" && !mockActive ? (
              <button
                type="button"
                className="btn btn-small btn-secondary"
                onClick={handleToggleMockMode}
              >
                Enable Mock Replay Mode
              </button>
            ) : null}
            {errorBanner.code === "bad_passcode" ? (
              <button
                type="button"
                className="btn btn-small btn-secondary"
                onClick={() => setShowPasscodeModal(true)}
              >
                Enter Passcode
              </button>
            ) : null}
          </div>
          <button
            type="button"
            className="btn-dismiss"
            aria-label="Dismiss alert"
            onClick={() => setErrorBanner(null)}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {snapshot?.status === "interrupted" ? (
        <div className="banner banner-warning global-banner no-print" role="status">
          <IconRefresh width={18} height={18} />
          <div className="banner-content">
            <span>
              This session was interrupted mid-run (e.g. server restart or sleep). Progress is saved
              in the Postgres checkpointer.
            </span>
            <button
              type="button"
              className="btn btn-small btn-primary"
              disabled={resumingRun}
              onClick={() => void handleResumeInterrupted()}
            >
              {resumingRun ? "Resuming from Checkpoint..." : "Resume Session"}
            </button>
          </div>
        </div>
      ) : null}

      {snapshot?.status === "failed" ? (
        <div className="banner banner-error global-banner no-print" role="alert">
          <IconAlert width={18} height={18} />
          <div className="banner-content">
            <span>
              The last run encountered an error. Send a message in the concierge chat to retry or
              adjust your target inputs.
            </span>
          </div>
        </div>
      ) : null}

      <main className="main-stage">
        {!sessionId ? (
          <StartScreen
            onSessionCreated={(id) => navigateToSession(id)}
            onOpenDemoSession={() => navigateToSession("demo")}
            onApiError={(err) => handleApiError(err)}
          />
        ) : notFoundSessionId ? (
          <section className="panel not-found-panel" role="alert" aria-labelledby="not-found-title">
            <div className="not-found-badge">404 · session_not_found</div>
            <h1 id="not-found-title">Session Not Found</h1>
            <p>
              We couldn&apos;t locate session <code>{notFoundSessionId}</code>. It may have expired
              or the URL may be incomplete.
            </p>
            <div className="not-found-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => navigateToSession(null)}
              >
                Return to Start Screen
              </button>
              {mockActive ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => navigateToSession("demo")}
                >
                  Open Demo Session (/s/demo)
                </button>
              ) : null}
            </div>
          </section>
        ) : loadingSession && !snapshot ? (
          <div className="panel empty-state">
            <p>Loading session snapshot and connecting live event stream...</p>
          </div>
        ) : snapshot ? (
          <div className="workspace-split">
            <aside className="chat-pane no-print" aria-label="Concierge assistant chat">
              <div className="pane-header">
                <h2>Concierge Assistant</h2>
                <span className="meta-tag">Session {snapshot.session_id.slice(0, 12)}</span>
              </div>

              <div className="chat-messages" role="log" aria-live="polite">
                {snapshot.messages.map((m) => (
                  <div key={m.id} className={`chat-bubble chat-${m.role}`}>
                    <div className="chat-role-label">
                      {m.role === "assistant" ? "Concierge" : "You"}
                    </div>
                    <p className="chat-text">{m.content}</p>
                  </div>
                ))}

                {streamingTokens ? (
                  <div className="chat-bubble chat-assistant chat-streaming">
                    <div className="chat-role-label">Concierge (typing...)</div>
                    <p className="chat-text">{streamingTokens}</p>
                  </div>
                ) : null}
              </div>

              {snapshot.status === "review" ? (
                <div className="chat-review-lock" role="status">
                  <IconAlert width={16} height={16} />
                  <div>
                    <strong>Review Pending</strong>
                    <p>
                      Chat is paused while proposals await your decision. Submit your choices in the{" "}
                      <button
                        type="button"
                        className="inline-link-btn"
                        onClick={() => setActiveTab("review")}
                      >
                        Review Proposals
                      </button>{" "}
                      tab to continue.
                    </p>
                  </div>
                </div>
              ) : (
                <form className="chat-composer" onSubmit={(e) => void handleSendMessage(e)}>
                  <label htmlFor="concierge-chat-input" className="sr-only">
                    Message the concierge
                  </label>
                  <textarea
                    id="concierge-chat-input"
                    className="input-textarea chat-input"
                    rows={2}
                    placeholder="Ask why a bullet was changed, or request a revision (e.g. 'Emphasize Kafka in exp0.b0')..."
                    value={chatInput}
                    disabled={sendingMessage || snapshot.status === "running"}
                    onChange={(e) => setChatInput(e.target.value)}
                  />
                  <button
                    type="submit"
                    className="btn btn-primary chat-send-btn"
                    disabled={sendingMessage || snapshot.status === "running" || !chatInput.trim()}
                  >
                    <IconSend width={15} height={15} />
                    <span>Send</span>
                  </button>
                </form>
              )}

              {mockActive ? (
                <div className="mock-simulator-bar">
                  <span>Inspect states:</span>
                  <button
                    type="button"
                    className="sim-chip"
                    onClick={() => handleSimulateState("review")}
                  >
                    Review Gate
                  </button>
                  <button
                    type="button"
                    className="sim-chip"
                    onClick={() => handleSimulateState("interrupted")}
                  >
                    Interrupted
                  </button>
                  <button
                    type="button"
                    className="sim-chip"
                    onClick={() => handleSimulateState("failed")}
                  >
                    Failed
                  </button>
                </div>
              ) : null}
            </aside>

            <section className="workbench-pane" aria-label="Optimization workbench">
              <nav className="workbench-tabs no-print" aria-label="Workbench views">
                <button
                  type="button"
                  className={`wb-tab ${activeTab === "timeline" ? "active" : ""}`}
                  onClick={() => setActiveTab("timeline")}
                >
                  <span>1. Live Pipeline &amp; Reports</span>
                </button>

                <button
                  type="button"
                  className={`wb-tab ${activeTab === "review" ? "active" : ""}`}
                  onClick={() => setActiveTab("review")}
                >
                  <span>2. Review Proposals</span>
                  {snapshot.proposals.length > 0 ? (
                    <span className="tab-count">{snapshot.proposals.length}</span>
                  ) : null}
                  {snapshot.status === "review" ? (
                    <span className="tab-attention">Action Needed</span>
                  ) : null}
                </button>

                <button
                  type="button"
                  className={`wb-tab ${activeTab === "export" ? "active" : ""}`}
                  onClick={() => setActiveTab("export")}
                >
                  <IconCheck width={14} height={14} />
                  <span>3. Export &amp; Print View</span>
                </button>
              </nav>

              <div className="workbench-content">
                {activeTab === "timeline" ? (
                  <TimelinePanel
                    nodes={nodes}
                    criticRounds={criticRounds}
                    flaggedCount={flaggedCount}
                    reports={snapshot.reports}
                    gap={snapshot.gap}
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
                    gap={snapshot.gap}
                    reports={snapshot.reports}
                    onOpenTimeline={() => setActiveTab("timeline")}
                    onSubmitReview={handleSubmitReview}
                  />
                ) : null}

                {activeTab === "export" ? (
                  <ExportPanel snapshot={snapshot} onApiError={(err) => handleApiError(err)} />
                ) : null}
              </div>
            </section>
          </div>
        ) : null}
      </main>
    </div>
  );
}
