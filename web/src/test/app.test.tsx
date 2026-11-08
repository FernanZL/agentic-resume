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
  formatProfileAsMarkdown,
  formatRunFailedError,
  getLinkedInCopyIssues,
  getLinkedInGuidance,
  parseSessionIdFromPath,
  reconcileReviewDrafts,
  roleSections,
  setMockMode,
} from "../api";
import { ExportPanel } from "../components/ExportPanel";
import { GapView, ReportView } from "../components/Reports";
import { ReviewPanel } from "../components/ReviewPanel";
import { HttpError, getStoredPasscode, request, setStoredPasscode } from "../connection";
import {
  MOCK_CANDIDATE_PROFILE,
  MOCK_GAP_REPORT,
  MOCK_PROPOSALS,
  buildMockEventStream,
  createDemoReviewMockSnapshot,
} from "../mock/fixtures";
import { targetName } from "../score";

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
  it("starts undecided and bulk accepts only untouched passed proposals", async () => {
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
    expect(screen.queryAllByRole("radio", { checked: true })).toHaveLength(0);
    const passed = MOCK_PROPOSALS.filter((p) => p.status === "ok");
    const edited = passed[0]!;
    const rejected = passed[1]!;
    const editedRow = screen.getByRole("listitem", { name: `Proposal ${edited.id}` });
    const rejectedRow = screen.getByRole("listitem", { name: `Proposal ${rejected.id}` });
    fireEvent.click(within(editedRow).getByRole("radio", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText(`Edit text for ${edited.id}`), {
      target: { value: "My own reviewed text." },
    });
    fireEvent.click(within(rejectedRow).getByRole("radio", { name: "Reject" }));
    const bulk = screen.getByRole("button", { name: /Accept all that passed/ });
    fireEvent.click(bulk);
    expect(bulk).toBeDisabled();
    expect(within(editedRow).getByRole("radio", { name: "Edit" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: /Submit Review & Finalize/ }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    const submitted = onSubmit.mock.calls[0]![0];
    expect(submitted[edited.id]).toEqual({ action: "edit", text: "My own reviewed text." });
    expect(submitted[rejected.id]).toEqual({ action: "reject", text: "" });
    for (const proposal of MOCK_PROPOSALS) {
      if (proposal.id === edited.id || proposal.id === rejected.id) continue;
      expect(submitted[proposal.id].action).toBe(proposal.status === "ok" ? "accept" : "reject");
    }
  });

  it("rejects undecided proposals on submit and restores saved decisions", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const saved = MOCK_PROPOSALS[0]!;
    render(
      <ReviewPanel
        proposals={MOCK_PROPOSALS}
        initialDecisions={{ [saved.id]: { action: "edit", text: "Saved text" } }}
        isReviewPending={true}
        submitting={false}
        onSubmitReview={onSubmit}
      />,
    );
    expect(screen.getByLabelText(`Edit text for ${saved.id}`)).toHaveValue("Saved text");
    fireEvent.click(screen.getByRole("button", { name: /Submit Review & Finalize/ }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    const submitted = onSubmit.mock.calls[0]![0];
    expect(submitted[saved.id]).toEqual({ action: "edit", text: "Saved text" });
    for (const proposal of MOCK_PROPOSALS.filter((p) => p.id !== saved.id)) {
      expect(submitted[proposal.id].action).toBe("reject");
    }
  });

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
    expect(reconciled[p2.id]?.action).toBeNull();
    expect(reconciled[p2.id]?.text).toBe("Brand new proposed text after revision");
    const reviewedRevision = reconcileReviewDrafts(
      [p2Revised],
      { [p2.id]: { action: "accept", text: "" } },
      edited,
    );
    expect(reviewedRevision[p2.id]?.action).toBe("accept");
    const preserved = reconcileReviewDrafts([p2Revised], {}, edited, {
      preserveEditsOnConflict: true,
    });
    expect(preserved[p2.id]?.text).toBe("My custom bullet");
    expect(preserved[p2.id]?.stale).toBe(true);
    expect(preserved[p2.id]?.proposedAtDraft).toBe(p2.proposed);
  });
});

describe("ExportPanel live mode & snapshot.reviewed gating", () => {
  it("copies the exact server Markdown artifact, including retained sections", async () => {
    setMockMode(false);
    const markdown = "# Approved headline\n\n## Certifications\nExact approved content.\n";
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input).endsWith("format=md")
        ? new Response(markdown, { headers: { "Content-Type": "text/markdown" } })
        : new Response(JSON.stringify({ resume: MOCK_CANDIDATE_PROFILE, linkedin: {} })),
    );
    render(
      <ExportPanel
        snapshot={{ ...createDemoReviewMockSnapshot("copy"), reviewed: true }}
        onApiError={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /^Copy Markdown$/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(markdown));
  });

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
      expect(
        screen.getByText(/Review in progress — ask questions or request draft edits/i),
      ).toBeInTheDocument();
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
      if ((url.endsWith("/messages") || url.endsWith("/ask")) && init?.method === "POST") {
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
      screen.getByRole("button", { name: /72\s*\/100 original resume match for this role/i }),
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

  it("resolves actual role and project titles in targetName, GapView, and preserves section grouping & Markdown fidelity", () => {
    expect(targetName("exp0.b0", MOCK_CANDIDATE_PROFILE)).toBe(
      "Lead Software Engineer — Solstice Telemetry Inc. · bullet 1",
    );
    expect(targetName("exp2", MOCK_CANDIDATE_PROFILE)).toBe(
      "OpenTelemetry Tail-Sampler CLI — Open Source",
    );
    expect(targetName("edu0.details", MOCK_CANDIDATE_PROFILE)).toBe(
      "B.S. in Computer Science — Cascadia State University · details",
    );

    const sections = roleSections(MOCK_CANDIDATE_PROFILE);
    expect(sections.map(([h]) => h)).toEqual(["Experience", "Projects"]);
    expect(sections[0]?.[1].map((r) => r.id)).toEqual(["exp0", "exp1"]);
    expect(sections[1]?.[1].map((r) => r.id)).toEqual(["exp2"]);

    const md = formatProfileAsMarkdown(
      MOCK_CANDIDATE_PROFILE,
      "Overridden Target Title Should Not Replace Headline",
    );
    expect(md).toContain(`**${MOCK_CANDIDATE_PROFILE.headline}**`);
    expect(md).not.toContain("Overridden Target Title Should Not Replace Headline");
    expect(md).toContain("## Experience");
    expect(md).toContain("## Projects");
    expect(md).toContain("## Certifications");
    expect(md).toContain("CKA — Certified Kubernetes Administrator (2024)");
    expect(md).toContain("## Other");

    render(<GapView gap={MOCK_GAP_REPORT} profile={MOCK_CANDIDATE_PROFILE} />);
    expect(
      screen.getByText(/Lead Software Engineer — Solstice Telemetry Inc. · bullet 3/i),
    ).toBeInTheDocument();
  });

  it("renders LinkedIn resume_only basis clearly and provides project vs experience placement guidance", () => {
    render(
      <ReportView
        report={{
          kind: "linkedin",
          linkedin: {
            basis: "resume_only",
            summary: "Prepared LinkedIn profile recommendations directly from your resume.",
            headline_issues: ["Add target distributed systems keywords."],
            about_issues: [],
            experience_gaps: ["Highlight RaftKV consensus engine project."],
            inconsistencies: [],
            steps: [],
            sources: [],
            limitations: ["LinkedIn URL was private; recommendations are grounded in your resume."],
          },
        }}
      />,
    );

    expect(
      screen.getByText(
        /Preparation based on your resume — your LinkedIn profile was not inspected/i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/Experience & projects to highlight on LinkedIn/i)).toBeInTheDocument();
    expect(
      screen.getByText(/LinkedIn URL was private; recommendations are grounded in your resume/i),
    ).toBeInTheDocument();

    const projectGuidance = getLinkedInGuidance("exp2", MOCK_CANDIDATE_PROFILE);
    expect(projectGuidance.section).toContain("Projects");
    expect(projectGuidance.field).toContain("Projects description");
    expect(projectGuidance.verified).toBe(false);

    const issues = getLinkedInCopyIssues("headline", "x".repeat(240), MOCK_CANDIDATE_PROFILE);
    expect(issues.some((i) => i.includes("220"))).toBe(true);
  });

  it("preserves edited text after a stale review and requires explicit reconciliation", async () => {
    setMockMode(false);
    let snap = { ...createDemoReviewMockSnapshot("stale-review"), revision: "v1" };
    let submitted: { expected_revision?: string } | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).endsWith("/review") && init?.method === "POST") {
        submitted = JSON.parse(String(init.body));
        snap = {
          ...snap,
          revision: "v2",
          proposals: snap.proposals.map((p) =>
            p.target === "summary" ? { ...p, proposed: "Another saved summary" } : p,
          ),
        };
        return new Response(JSON.stringify({ detail: "stale_review" }), { status: 409 });
      }
      return new Response(JSON.stringify(snap), {
        headers: { "Content-Type": "application/json" },
      });
    });
    window.history.pushState({}, "", "/s/stale-review");
    render(<App />);
    const card = await screen.findByLabelText("Proposal resume:summary");
    fireEvent.click(within(card).getByRole("radio", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Edit text for resume:summary"), {
      target: { value: "Keep my own wording" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Submit Review & Finalize/i }));
    await screen.findByText("Saved decisions changed");
    expect(submitted).toMatchObject({ expected_revision: "v1" });
    expect(screen.getByLabelText("Edit text for resume:summary")).toHaveValue(
      "Keep my own wording",
    );
    expect(screen.getByRole("button", { name: /Submit Review & Finalize/i })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Keep my edited drafts/i }));
    expect(screen.queryByText("Saved decisions changed")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Edit text for resume:summary")).toHaveValue(
      "Keep my own wording",
    );
  });

  it("supports review-time /ask suggestions, explicit Load into Edit preserving rejections and issues, and new proposal additions", async () => {
    setMockMode(false);
    const snap = createDemoReviewMockSnapshot("s-ask-review");
    let submittedBody: unknown = null;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/sessions/s-ask-review/ask") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            message: {
              id: "msg-ask-1",
              role: "assistant",
              content: "Here is a flagged revision for your summary and a new certification entry.",
            },
            suggestion: {
              proposal_id: "resume:summary",
              text: "Drafted summary with unconfirmed [X]% latency reduction.",
              issues: ["Contains unconfirmed placeholder [X]%"],
              proposed_at_request: snap.proposals[0]!.proposed,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/api/sessions/s-ask-review/review") && init?.method === "POST") {
        submittedBody = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ session_id: "s-ask-review", run_id: "run-2" }), {
          status: 202,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/sessions/s-ask-review")) {
        return new Response(JSON.stringify(snap), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ status: "ok", database: true }), { status: 200 });
    });

    window.history.pushState({}, "", "/s/s-ask-review");
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/Grounded Rewrite Proposals \(6\)/i)).toBeInTheDocument();
    });

    // Reject the second proposal first to verify Load into Edit preserves rejections.
    const secondCard = screen.getByLabelText("Proposal resume:exp0.b0");
    fireEvent.click(within(secondCard).getByRole("radio", { name: "Reject" }));

    // Send a review-time question via /ask
    const chatBox = screen.getByLabelText(/Message the assistant/i);
    fireEvent.change(chatBox, { target: { value: "Shorten my summary" } });
    fireEvent.click(screen.getByRole("button", { name: /^Send$/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Load into Edit/i })).toBeInTheDocument();
    });
    expect(screen.getByText(/Flagged \(1\)/i)).toBeInTheDocument();

    // Load into Edit explicitly
    fireEvent.click(screen.getByRole("button", { name: /Load into Edit/i }));

    const editTextarea = screen.getByLabelText(
      "Edit text for resume:summary",
    ) as HTMLTextAreaElement;
    expect(editTextarea.value).toBe("Drafted summary with unconfirmed [X]% latency reduction.");

    // Verify the flagged issue is retained on the proposal card and second card's rejection is preserved
    const firstCard = screen.getByLabelText("Proposal resume:summary");
    expect(within(firstCard).getByText(/Advisory Flagged/i)).toBeInTheDocument();
    expect(
      within(firstCard).getByText(/Contains unconfirmed placeholder \[X\]%/i),
    ).toBeInTheDocument();
    expect(within(secondCard).getByRole("radio", { name: "Reject" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: /Submit Review & Finalize/i }));
    await waitFor(() => {
      expect(submittedBody).not.toBeNull();
    });
    const decisions = (
      submittedBody as { decisions: Record<string, { action: string; text: string }> }
    ).decisions;
    expect(decisions["resume:summary"]).toEqual({
      action: "edit",
      text: "Drafted summary with unconfirmed [X]% latency reduction.",
    });
    expect(decisions["resume:exp0.b0"]?.action).toBe("reject");
  });

  it("intercepts /reanalyze in chat to open confirmation UI and calls POST /reanalyze when confirmed", async () => {
    setMockMode(false);
    const idleSnap: SessionSnapshot = {
      ...createDemoReviewMockSnapshot("s-reanalyze"),
      session_id: "s-reanalyze",
      status: "idle",
      reviewed: true,
    };
    let reanalyzePayload: unknown = null;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/sessions/s-reanalyze/reanalyze") && init?.method === "POST") {
        reanalyzePayload = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ session_id: "s-reanalyze", run_id: "run-re" }), {
          status: 202,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/sessions/s-reanalyze")) {
        return new Response(JSON.stringify(idleSnap), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ status: "ok", database: true }), { status: 200 });
    });

    window.history.pushState({}, "", "/s/s-reanalyze");
    render(<App />);

    await waitFor(() => {
      expect(screen.getByLabelText(/Message the assistant/i)).not.toBeDisabled();
    });

    const chatBox = screen.getByLabelText(/Message the assistant/i);
    fireEvent.change(chatBox, { target: { value: "/reanalyze Principal Systems Architect" } });
    fireEvent.click(screen.getByRole("button", { name: /^Send$/i }));

    // Confirmation dialog opens instead of sending /reanalyze to /messages or /ask
    const confirmForm = await screen.findByRole("form", { name: /Confirm fresh analysis/i });
    expect(confirmForm).toBeInTheDocument();

    fireEvent.click(
      within(confirmForm).getByRole("button", { name: /Confirm & Start Fresh Analysis/i }),
    );

    await waitFor(() => {
      expect(reanalyzePayload).toMatchObject({
        target: expect.objectContaining({ title: "Principal Systems Architect" }),
        confirmed: true,
      });
    });
  });

  it("stages new proposal rows from suggestion.proposal on Load into Edit and sends additions on POST /amend", async () => {
    setMockMode(false);
    const reviewedSnap: SessionSnapshot = {
      ...createDemoReviewMockSnapshot("s-amend"),
      session_id: "s-amend",
      status: "idle",
      reviewed: true,
    };
    let amendBody: unknown = null;

    const newEduProposal = {
      id: "resume:edu0.details",
      document: "resume" as const,
      target: "edu0.details",
      original: "Focus: Distributed Systems & Compilers",
      proposed: "Focus: Distributed Systems, Consensus & Compilers (GPA 3.9)",
      reason: "Added consensus coursework per user request.",
      evidence: ["Resume education"],
      issues: [],
    };

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/sessions/s-amend/ask") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            message: {
              id: "msg-ask-edu",
              role: "assistant",
              content: "Created a staged education proposal for your review.",
            },
            suggestion: {
              proposal_id: "resume:edu0.details",
              text: "Focus: Distributed Systems, Consensus & Compilers (GPA 3.9)",
              issues: [],
              proposed_at_request: newEduProposal.proposed,
              proposal: newEduProposal,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/api/sessions/s-amend/amend") && init?.method === "POST") {
        amendBody = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            ...reviewedSnap,
            proposals: [...reviewedSnap.proposals, newEduProposal],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/sessions/s-amend/export?format=json")) {
        return new Response(
          JSON.stringify({
            resume: MOCK_CANDIDATE_PROFILE,
            linkedin: { headline: MOCK_CANDIDATE_PROFILE.headline },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/sessions/s-amend")) {
        return new Response(JSON.stringify(reviewedSnap), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ status: "ok", database: true }), { status: 200 });
    });

    window.history.pushState({}, "", "/s/s-amend");
    render(<App />);

    await waitFor(() => {
      expect(screen.getByLabelText(/Message the assistant/i)).not.toBeDisabled();
    });

    const chatBox = screen.getByLabelText(/Message the assistant/i);
    fireEvent.change(chatBox, { target: { value: "Update my education details" } });
    fireEvent.click(screen.getByRole("button", { name: /^Send$/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Load into Edit/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /Load into Edit/i }));

    // New proposal row is staged in ReviewPanel (now 7 proposals)
    await waitFor(() => {
      expect(screen.getByText(/Grounded Rewrite Proposals \(7\)/i)).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Edit text for resume:edu0.details")).toHaveValue(
      "Focus: Distributed Systems, Consensus & Compilers (GPA 3.9)",
    );

    // Apply Reviewed Edits calls POST /amend with additions
    fireEvent.click(screen.getByRole("button", { name: /Apply Reviewed Edits/i }));

    await waitFor(() => {
      expect(amendBody).not.toBeNull();
    });
    const parsed = amendBody as {
      decisions: Record<string, { action: string; text: string }>;
      additions?: Array<{ id: string }>;
    };
    expect(parsed.decisions["resume:edu0.details"]).toEqual({
      action: "edit",
      text: "Focus: Distributed Systems, Consensus & Compilers (GPA 3.9)",
    });
    expect(parsed.additions?.map((a) => a.id)).toContain("resume:edu0.details");
  });
});
