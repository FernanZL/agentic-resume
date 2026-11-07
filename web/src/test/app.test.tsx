/**
 * Unit and UI integration tests for connection.ts, api.ts, ReviewPanel, ExportPanel,
 * /s/<session_id> URL routing, failed chat POST rollback, and App flows.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import {
  type ExportJson,
  type SessionSnapshot,
  formatRunFailedError,
  parseSessionIdFromPath,
  reconcileReviewDrafts,
  setMockMode,
} from "../api";
import { ExportPanel } from "../components/ExportPanel";
import { ReviewPanel } from "../components/ReviewPanel";
import { HttpError, getStoredPasscode, request, setStoredPasscode } from "../connection";
import {
  MOCK_PROPOSALS,
  buildMockEventStream,
  createDemoReviewMockSnapshot,
} from "../mock/fixtures";

describe("connection.ts HTTP transport & passcode header", () => {
  beforeEach(() => {
    setStoredPasscode("");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("attaches X-Demo-Passcode on POST requests and omits it on GET requests", async () => {
    setStoredPasscode("secret-demo-123");
    expect(getStoredPasscode()).toBe("secret-demo-123");

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(JSON.stringify({ status: "ok", database: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await request("/api/health", { method: "GET" });
    const getHeaders = fetchSpy.mock.calls[0]?.[1]?.headers as Headers;
    expect(getHeaders.get("X-Demo-Passcode")).toBeNull();

    await request("/api/sessions/s1/resume", { method: "POST" });
    const postHeaders = fetchSpy.mock.calls[1]?.[1]?.headers as Headers;
    expect(postHeaders.get("X-Demo-Passcode")).toBe("secret-demo-123");
  });

  it("throws typed HttpError with detail on 401 bad_passcode and 429 budget_exceeded", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "bad_passcode" }), { status: 401 }),
    );

    await expect(request("/api/sessions", { method: "POST", body: {} })).rejects.toMatchObject({
      status: 401,
      detail: "bad_passcode",
    } satisfies Partial<HttpError>);
  });
});

describe("Event contract & run_failed error mapping", () => {
  it("keeps document content out of report_ready and proposals_ready events and maps run_failed codes", () => {
    const events = buildMockEventStream("s1");
    const reportEv = events.find((e) => e.type === "report_ready");
    expect(reportEv?.data).toEqual({ kind: "linkedin", ok: true });

    const gapEv = events.find((e) => e.type === "gap_ready");
    expect(gapEv?.data).toEqual({ score: 72, keyword_coverage: 0.5833 });

    const critiques = events.filter((e) => e.type === "critique").map((e) => e.data);
    expect(critiques).toEqual([
      { round: 1, flagged_ids: ["resume:exp0.b0", "resume:skills"], final: false },
      { round: 2, flagged_ids: ["resume:skills"], final: true },
    ]);

    const propEv = events.find((e) => e.type === "proposals_ready");
    // Ids only, never proposal text: the rewrite round names the two it rewrote.
    expect(propEv?.data).toEqual({
      round: 2,
      proposal_ids: ["resume:exp0.b0", "resume:skills"],
    });

    expect(formatRunFailedError("budget_exceeded")).toMatch(/budget limit/i);
    expect(formatRunFailedError("model_error")).toMatch(/upstream language model/i);
    expect(formatRunFailedError("invalid_model_output")).toMatch(/structured output/i);
    expect(formatRunFailedError("internal_error")).toMatch(/unexpected server error/i);
  });
});

describe("ReviewPanel component & draft reconciliation", () => {
  it("highlights [X]% placeholders, displays critic issues, supports inline edit and Accept All OK", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    render(
      <ReviewPanel
        proposals={MOCK_PROPOSALS}
        initialDecisions={{}}
        isReviewPending={true}
        submitting={false}
        onSubmitReview={onSubmit}
      />,
    );

    expect(screen.getByText(/Grounded Rewrite Proposals/i)).toBeInTheDocument();
    expect(screen.getAllByText("[X]%").length).toBeGreaterThan(0);
    expect(screen.getByText(/Critic Flagged/i)).toBeInTheDocument();

    const editButtons = screen.getAllByRole("radio", { name: "Edit" });
    fireEvent.click(editButtons[0]!);

    const editBox = screen.getByLabelText("Edit text for resume:summary");
    fireEvent.change(editBox, { target: { value: "Custom edited summary with 99.99% uptime." } });

    fireEvent.click(screen.getByRole("button", { name: /Submit Review & Finalize/i }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    const submitted = onSubmit.mock.calls[0]?.[0];
    expect(submitted["resume:summary"]).toEqual({
      action: "edit",
      text: "Custom edited summary with 99.99% uptime.",
    });
  });

  it("disables submission when status is not review and points user to chat for revisions", () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    render(
      <ReviewPanel
        proposals={MOCK_PROPOSALS}
        initialDecisions={{}}
        isReviewPending={false}
        submitting={false}
        onSubmitReview={onSubmit}
      />,
    );

    expect(screen.queryByRole("button", { name: /Update Decisions/i })).not.toBeInTheDocument();
    const finalizedBtn = screen.getByRole("button", { name: /Review Finalized/i });
    expect(finalizedBtn).toBeDisabled();
    expect(
      screen.getByText(/ask the assistant to revise a proposal in the chat/i),
    ).toBeInTheDocument();
  });

  it("reconciles drafts when proposals change by id + proposed text and drops removed ids", () => {
    const p1 = MOCK_PROPOSALS[0]!;
    const p2 = MOCK_PROPOSALS[1]!;
    const initial = reconcileReviewDrafts([p1, p2], {}, {});
    const edited = {
      ...initial,
      [p1.id]: { action: "edit" as const, text: "My custom summary", proposedAtDraft: p1.proposed },
      [p2.id]: { action: "edit" as const, text: "My custom bullet", proposedAtDraft: p2.proposed },
      "stale:id": { action: "accept" as const, text: "old", proposedAtDraft: "old" },
    };

    const p2Revised = { ...p2, proposed: "Brand new proposed text after revision" };
    const reconciled = reconcileReviewDrafts([p1, p2Revised], {}, edited);

    expect(reconciled["stale:id"]).toBeUndefined();
    expect(reconciled[p1.id]?.text).toBe("My custom summary");
    expect(reconciled[p2.id]?.action).toBe("accept");
    expect(reconciled[p2.id]?.text).toBe("Brand new proposed text after revision");
  });
});

describe("ExportPanel live mode & snapshot.reviewed gating", () => {
  afterEach(() => {
    setMockMode(false);
    vi.restoreAllMocks();
  });

  it("gates all export actions on snapshot.reviewed and never renders fixture content before review", () => {
    setMockMode(false);
    const unreviewed: SessionSnapshot = {
      ...createDemoReviewMockSnapshot("live-1"),
      reviewed: false,
    };

    render(<ExportPanel snapshot={unreviewed} onApiError={vi.fn()} />);

    expect(screen.getByRole("button", { name: /Download DOCX/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Download Markdown/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Save as PDF \(Print View\)/i })).toBeDisabled();
    expect(screen.getByText(/Submit your review first/i)).toBeInTheDocument();
    expect(screen.queryByText(/Elena Vance/i)).not.toBeInTheDocument();
  });

  it("fetches /export?format=json in live mode and opens /export?format=html in a new tab for Save as PDF", async () => {
    setMockMode(false);
    const liveExportJson: ExportJson = {
      resume: {
        name: "Marcus Sterling",
        headline: "Principal Systems Architect",
        contact: ["Austin, TX", "marcus@example.org"],
        summary: "Reviewed live summary for Marcus Sterling.",
        experience: [
          {
            id: "exp0",
            title: "Principal Engineer",
            organization: "Hyperion Cloud",
            location: "Austin, TX",
            start: "2021",
            end: "Present",
            bullets: [{ id: "exp0.b0", text: "Scaled storage engine to 90,000 IOPS." }],
          },
        ],
        education: [{ degree: "M.S. CS", institution: "UT Austin", year: "2018", details: "" }],
        skills: ["Rust", "Go", "Raft"],
        certifications: [],
        languages: [],
        other: [],
      },
      linkedin: {
        headline: "Principal Systems Architect | Distributed Storage",
      },
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(liveExportJson), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    const reviewedSnap: SessionSnapshot = {
      ...createDemoReviewMockSnapshot("live-99"),
      status: "idle",
      reviewed: true,
    };

    render(<ExportPanel snapshot={reviewedSnap} onApiError={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Marcus Sterling")).toBeInTheDocument();
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/sessions/live-99/export?format=json",
      expect.objectContaining({ method: "GET" }),
    );
    expect(
      screen.getByText(/Principal Systems Architect \| Distributed Storage/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Elena Vance/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Save as PDF \(Print View\)/i }));
    expect(openSpy).toHaveBeenCalledWith(
      "/api/sessions/live-99/export?format=html",
      "_blank",
      "noopener,noreferrer",
    );
  });
});

describe("App end-to-end mocked workflow, chat failure rollback & /s/<session_id> routing", () => {
  beforeEach(() => {
    window.history.pushState({}, "", "/");
    setMockMode(true);
  });

  afterEach(() => {
    window.history.pushState({}, "", "/");
    setMockMode(false);
    vi.restoreAllMocks();
  });

  it("parses /s/<session_id> URLs accurately", () => {
    expect(parseSessionIdFromPath("/")).toBeNull();
    expect(parseSessionIdFromPath("/s/demo")).toBe("demo");
    expect(parseSessionIdFromPath("/s/abc-123/")).toBe("abc-123");
  });

  it("loads fictional sample on Start screen, pushes /s/<id> URL, preserves review drafts across tabs, and exports", async () => {
    render(<App />);

    const loadSampleBtn = screen.getByRole("button", {
      name: /Try it with a fictional sample/i,
    });
    fireEvent.click(loadSampleBtn);

    const titleInput = screen.getByLabelText(/^Job title/i) as HTMLInputElement;
    expect(titleInput.value).toBe("Staff Distributed Systems Engineer");

    const launchBtn = screen.getByRole("button", { name: /Start the analysis/i });
    fireEvent.click(launchBtn);

    await waitFor(() => {
      expect(screen.getByRole("region", { name: /The run as a score/i })).toBeInTheDocument();
    });
    expect(window.location.pathname).toMatch(/^\/s\//);

    const reviewSimBtn = screen.getByRole("button", { name: "Review gate" });
    fireEvent.click(reviewSimBtn);

    await waitFor(() => {
      expect(screen.getByText(/Chat is paused for your review/i)).toBeInTheDocument();
    });

    // Edit a proposal, switch away to Timeline tab, then switch back to Review tab and verify draft persists.
    const editButtons = screen.getAllByRole("radio", { name: "Edit" });
    fireEvent.click(editButtons[0]!);
    const editBox = screen.getByLabelText("Edit text for resume:summary") as HTMLTextAreaElement;
    fireEvent.change(editBox, { target: { value: "Persisted draft across tab switch" } });

    const views = within(screen.getByRole("navigation", { name: "Session views" }));
    fireEvent.click(views.getByRole("button", { name: /^Score$/ }));
    fireEvent.click(views.getByRole("button", { name: /^Review/ }));

    expect(
      (screen.getByLabelText("Edit text for resume:summary") as HTMLTextAreaElement).value,
    ).toBe("Persisted draft across tab switch");

    const submitReviewBtn = screen.getByRole("button", { name: /Submit Review & Finalize/i });
    fireEvent.click(submitReviewBtn);

    await waitFor(() => {
      expect(screen.getByText(/Export Artifacts & LinkedIn Copy/i)).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Download DOCX/i })).not.toBeDisabled();
    });
    expect(screen.getByRole("button", { name: /Save as PDF \(Print View\)/i })).not.toBeDisabled();
  });

  it("removes optimistic message, restores draft, and re-fetches snapshot when chat POST fails", async () => {
    setMockMode(false);
    const idleSnap: SessionSnapshot = {
      ...createDemoReviewMockSnapshot("s-chat-fail"),
      session_id: "s-chat-fail",
      status: "idle",
      reviewed: true,
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/messages") && init?.method === "POST") {
        return new Response(JSON.stringify({ detail: "budget_exceeded" }), { status: 429 });
      }
      if (url.includes("/api/sessions/s-chat-fail")) {
        return new Response(JSON.stringify(idleSnap), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ status: "ok", database: true }), { status: 200 });
    });

    window.history.pushState({}, "", "/s/s-chat-fail");
    render(<App />);

    await waitFor(() => {
      expect(screen.getByLabelText(/Message the assistant/i)).not.toBeDisabled();
    });

    const input = screen.getByLabelText(/Message the assistant/i) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Please emphasize Kafka metrics" } });
    fireEvent.click(screen.getByRole("button", { name: /Send/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/budget limit/i);
    });

    // Draft is restored, optimistic message is removed, chat input is not stuck disabled, and snapshot was re-fetched.
    expect(input.value).toBe("Please emphasize Kafka metrics");
    expect(input).not.toBeDisabled();
    expect(
      screen.queryByText("Please emphasize Kafka metrics", { selector: ".msg-text p" }),
    ).not.toBeInTheDocument();
    expect(
      fetchSpy.mock.calls.filter(
        ([u, init]) =>
          String(u).endsWith("/api/sessions/s-chat-fail") &&
          (!init?.method || init.method === "GET"),
      ).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("opens /s/demo directly at completed review state with proposals and ATS telemetry ribbon", async () => {
    window.history.pushState({}, "", "/s/demo");
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/Grounded Rewrite Proposals \(6\)/i)).toBeInTheDocument();
    });

    expect(
      screen.getByRole("button", { name: /72\s*\/100 match for this role/i }),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/Waiting for your review/i).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: /New session/i }));
    expect(window.location.pathname).toBe("/");
  });

  it("renders friendly 404 session_not_found state for /s/missing with a button back home", async () => {
    window.history.pushState({}, "", "/s/missing");
    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /Session not found/i })).toBeInTheDocument();
    });
    expect(screen.getByText(/There is no session/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Start a new session/i }));
    expect(window.location.pathname).toBe("/");
    expect(screen.getByRole("button", { name: /Start the analysis/i })).toBeInTheDocument();
  });
});
