/**
 * Server-Sent Events (SSE) subscription wrapper for /api/sessions/{id}/events.
 * Resumes after snapshot.last_event_id and supports scripted mock replay in VITE_MOCK=1.
 */

import {
  type Event,
  type EventType,
  isMockMode,
  subscribeMockEvents,
  updateMockSnapshotState,
} from "./api";
import {
  MOCK_GAP_REPORT,
  MOCK_PROPOSALS,
  MOCK_REPORTS,
  buildMockEventStream,
} from "./mock/fixtures";

const ALL_EVENT_TYPES: EventType[] = [
  "run_started",
  "node_started",
  "node_finished",
  "tool_called",
  "token",
  "message",
  "report_ready",
  "gap_ready",
  "proposals_ready",
  "critique",
  "review_required",
  "run_completed",
  "run_failed",
];

export interface EventStreamHandlers {
  onEvent: (event: Event) => void;
  onError?: (err: unknown) => void;
}

export function connectSessionEvents(
  sessionId: string,
  afterEventId: number,
  handlers: EventStreamHandlers,
): () => void {
  if (isMockMode()) {
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const scripted = buildMockEventStream(sessionId).filter((ev) => ev.id > afterEventId);

    scripted.forEach((ev, idx) => {
      const timer = setTimeout(
        () => {
          updateMockSnapshotState((prev) => {
            const next = { ...prev, last_event_id: Math.max(prev.last_event_id, ev.id) };
            if (ev.type === "report_ready") {
              const kind = typeof ev.data.kind === "string" ? ev.data.kind : "";
              if (kind && MOCK_REPORTS[kind]) {
                next.reports = { ...next.reports, [kind]: MOCK_REPORTS[kind] };
              }
            } else if (ev.type === "gap_ready") {
              next.gap = MOCK_GAP_REPORT;
            } else if (ev.type === "proposals_ready" || ev.type === "critique") {
              next.proposals = MOCK_PROPOSALS;
            } else if (ev.type === "review_required") {
              next.status = "review";
              next.reports = MOCK_REPORTS;
              next.gap = MOCK_GAP_REPORT;
              next.proposals = MOCK_PROPOSALS;
            }
            return next;
          });
          // A live mock run is stamped as it arrives so the score plays in real time;
          // the finished demo keeps its scripted, realistic timing.
          handlers.onEvent(sessionId === "demo" ? ev : { ...ev, at: new Date().toISOString() });
        },
        (idx + 1) * (sessionId === "demo" ? 40 : 450),
      );
      timers.push(timer);
    });

    const unsubLive = subscribeMockEvents((liveEv) => {
      handlers.onEvent(liveEv);
    });

    return () => {
      timers.forEach((t) => clearTimeout(t));
      unsubLive();
    };
  }

  if (typeof EventSource === "undefined") {
    return () => {};
  }

  const url = `/api/sessions/${encodeURIComponent(sessionId)}/events?after=${encodeURIComponent(String(afterEventId))}`;
  const source = new EventSource(url);

  const handleRawMessage = (msgEvent: MessageEvent) => {
    if (!msgEvent.data) return;
    try {
      const parsed = JSON.parse(String(msgEvent.data)) as Event;
      if (parsed && typeof parsed.type === "string") {
        handlers.onEvent(parsed);
      }
    } catch (err) {
      handlers.onError?.(err);
    }
  };

  ALL_EVENT_TYPES.forEach((eventType) => {
    source.addEventListener(eventType, handleRawMessage as EventListener);
  });
  source.onerror = (err) => {
    handlers.onError?.(err);
  };

  return () => {
    source.close();
  };
}
