import { describe, it, expect, vi, beforeEach } from "vitest";

// Records the params passed to each messages.create call so we can assert on
// container threading. Queue of responses the fake client returns in order.
const createCalls: Array<Record<string, unknown>> = [];
let responses: Array<Record<string, unknown>> = [];

vi.mock("../run-context.js", () => ({
  runWithScope: (_uid: string, fn: () => unknown) => fn(),
}));

vi.mock("./anthropic.js", () => ({
  agentModel: () => "test-model",
  getAnthropic: () =>
    Promise.resolve({
      messages: {
        create: (params: Record<string, unknown>) => {
          createCalls.push(params);
          return Promise.resolve(responses.shift() ?? { content: [], stop_reason: "end_turn" });
        },
      },
    }),
}));

vi.mock("./tools-bridge.js", () => ({
  SEARCH_AGENT_TOOLS: [],
  buildToolBridge: () => ({ tools: [], handlers: new Map() }),
  runBridgedTool: (_bridge: unknown, name: string, _input: unknown) =>
    Promise.resolve(
      name === "pipeline_upsert_jobs"
        ? { text: JSON.stringify({ added: 1, updated: 0 }), isError: false }
        : { text: "{}", isError: false },
    ),
}));

// Audit is exercised in search-audit.test.ts; here we just assert it gets invoked
// with the jobs/observed-text the loop collected.
const auditMock = vi.fn(() =>
  Promise.resolve({ total: 1, clean: 1, flagged: 0, fabricated: [], results: [] }),
);
const flagNotesMock = vi.fn((): Array<{ applyLink: string; note: string }> => []);
vi.mock("./search-audit.js", () => ({
  auditSearchRun: (...args: unknown[]) => auditMock(...(args as [])),
  summarizeAudit: () => "Audit: 1/1 jobs clean.",
  auditFlagNotes: (...args: unknown[]) => flagNotesMock(...(args as [])),
}));

const annotateMock = vi.fn((..._args: unknown[]) => Promise.resolve({ matched: 0 }));
vi.mock("../pipeline.js", () => ({
  annotatePipelineEntries: (...args: unknown[]) => annotateMock(...args),
}));

import { runSearchAgent } from "./search-agent.js";

beforeEach(() => {
  createCalls.length = 0;
  responses = [];
  auditMock.mockClear();
  flagNotesMock.mockClear();
  flagNotesMock.mockReturnValue([]);
  annotateMock.mockClear();
});

describe("runSearchAgent container threading", () => {
  it("reattaches the code-execution container on subsequent requests", async () => {
    // Turn 1: web_search dynamic filtering spins up a container and asks for a tool.
    responses.push({
      stop_reason: "tool_use",
      container: { id: "ctr_abc123" },
      content: [{ type: "tool_use", id: "tu_1", name: "jobsync_ping", input: {} }],
    });
    // Turn 2: model wraps up.
    responses.push({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Done — added 0 jobs." }],
    });

    await runSearchAgent("user-1", { lookbackHours: 24 });

    expect(createCalls).toHaveLength(2);
    // First request opens the container; no id to send yet.
    expect(createCalls[0]!.container).toBeNull();
    // Second request must reattach to the container the first turn created.
    expect(createCalls[1]!.container).toBe("ctr_abc123");
  });

  it("keeps the container id across a pause_turn resume", async () => {
    responses.push({
      stop_reason: "pause_turn",
      container: { id: "ctr_pause" },
      content: [{ type: "text", text: "searching..." }],
    });
    responses.push({ stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] });

    await runSearchAgent("user-2", {});

    expect(createCalls).toHaveLength(2);
    expect(createCalls[1]!.container).toBe("ctr_pause");
  });

  it("does not send a container when none was created", async () => {
    responses.push({ stop_reason: "end_turn", content: [{ type: "text", text: "no results" }] });

    await runSearchAgent("user-3", {});

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]!.container).toBeNull();
  });
});

describe("runSearchAgent post-run audit", () => {
  it("audits the jobs upserted during the run and attaches the report", async () => {
    const upsert = {
      type: "tool_use",
      id: "tu_up",
      name: "pipeline_upsert_jobs",
      input: {
        jobs: [
          {
            applyLink: "https://boards.greenhouse.io/acme/jobs/1",
            positionTitle: "ML Engineer",
            datePosted: "2026-06-09",
            company: "Acme",
          },
        ],
      },
    };
    responses.push({ stop_reason: "tool_use", content: [upsert] });
    responses.push({ stop_reason: "end_turn", content: [{ type: "text", text: "Added 1 job." }] });

    const result = await runSearchAgent("user-4", { lookbackHours: 48, roles: ["ml engineer"] });

    expect(auditMock).toHaveBeenCalledTimes(1);
    const [jobs, , opts] = auditMock.mock.calls[0]! as unknown as [
      Array<{ applyLink: string }>,
      string,
      { lookbackHours: number; roles?: string[] },
    ];
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.applyLink).toBe("https://boards.greenhouse.io/acme/jobs/1");
    expect(opts.lookbackHours).toBe(48);
    expect(result.audit).toEqual({ total: 1, clean: 1, flagged: 0, fabricated: [], results: [] });
  });

  it("skips the audit when no jobs were upserted", async () => {
    responses.push({ stop_reason: "end_turn", content: [{ type: "text", text: "nothing found" }] });

    const result = await runSearchAgent("user-5", {});

    expect(auditMock).not.toHaveBeenCalled();
    expect(result.audit).toBeUndefined();
  });

  it("annotates the pipeline only for jobs the audit flagged", async () => {
    const link = "https://boards.greenhouse.io/acme/jobs/2";
    const upsert = {
      type: "tool_use",
      id: "tu_up",
      name: "pipeline_upsert_jobs",
      input: { jobs: [{ applyLink: link, positionTitle: "ML Engineer", datePosted: "2026-01-01" }] },
    };
    responses.push({ stop_reason: "tool_use", content: [upsert] });
    responses.push({ stop_reason: "end_turn", content: [{ type: "text", text: "Added 1 job." }] });
    flagNotesMock.mockReturnValue([{ applyLink: link, note: "⚠ audit: stale" }]);

    await runSearchAgent("user-6", { lookbackHours: 48 });

    expect(annotateMock).toHaveBeenCalledTimes(1);
    expect(annotateMock.mock.calls[0]![0]).toEqual([{ applyLink: link, note: "⚠ audit: stale" }]);
  });

  it("does not annotate when the audit found nothing to flag", async () => {
    const upsert = {
      type: "tool_use",
      id: "tu_up",
      name: "pipeline_upsert_jobs",
      input: { jobs: [{ applyLink: "https://x/y", positionTitle: "ML Engineer", datePosted: "2026-06-09" }] },
    };
    responses.push({ stop_reason: "tool_use", content: [upsert] });
    responses.push({ stop_reason: "end_turn", content: [{ type: "text", text: "Added 1 job." }] });
    // flagNotesMock defaults to [] — clean run.

    await runSearchAgent("user-7", {});

    expect(annotateMock).not.toHaveBeenCalled();
  });
});
