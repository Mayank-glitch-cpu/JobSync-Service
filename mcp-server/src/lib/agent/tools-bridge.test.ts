import { describe, it, expect } from "vitest";
import { runBridgedTool, type ToolBridge } from "./tools-bridge.js";

function bridgeWith(handlers: ToolBridge["handlers"]): ToolBridge {
  return { tools: [], handlers };
}

describe("runBridgedTool", () => {
  it("dispatches to the handler and flattens text blocks", async () => {
    const bridge = bridgeWith(
      new Map([
        ["echo", async (args: Record<string, unknown>) => ({
          content: [{ type: "text" as const, text: `got ${args.x}` }],
        })],
      ]),
    );
    const result = await runBridgedTool(bridge, "echo", { x: 42 });
    expect(result).toEqual({ text: "got 42", isError: false });
  });

  it("reports unknown tools as errors", async () => {
    const result = await runBridgedTool(bridgeWith(new Map()), "missing", {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Unknown tool");
  });

  it("propagates a handler's isError flag", async () => {
    const bridge = bridgeWith(
      new Map([
        ["bad", async () => ({ content: [{ type: "text" as const, text: "nope" }], isError: true })],
      ]),
    );
    expect(await runBridgedTool(bridge, "bad", {})).toEqual({ text: "nope", isError: true });
  });

  it("catches handler exceptions", async () => {
    const bridge = bridgeWith(
      new Map([["boom", async () => { throw new Error("kaboom"); }]]),
    );
    const result = await runBridgedTool(bridge, "boom", {});
    expect(result.isError).toBe(true);
    expect(result.text).toBe("kaboom");
  });
});
