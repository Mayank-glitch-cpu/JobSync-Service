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
  runBridgedTool: () => Promise.resolve({ text: "{}", isError: false }),
}));

import { runSearchAgent } from "./search-agent.js";

beforeEach(() => {
  createCalls.length = 0;
  responses = [];
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
