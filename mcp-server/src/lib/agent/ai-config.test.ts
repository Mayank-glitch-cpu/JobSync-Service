import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_AGENT_MODEL,
  aiCall,
  aiRequestParams,
  globalModel,
  resetAiConfigCache,
  searchAgentConfig,
} from "./ai-config.js";

let dir: string;
const savedModel = process.env.JOBSYNC_AGENT_MODEL;
const savedPath = process.env.JOBSYNC_AI_CONFIG;

/** Point the loader at a throwaway config file with the given contents. */
function useConfig(config: unknown): void {
  const path = join(dir, "ai.config.json");
  writeFileSync(path, JSON.stringify(config));
  process.env.JOBSYNC_AI_CONFIG = path;
  resetAiConfigCache();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-config-"));
  delete process.env.JOBSYNC_AGENT_MODEL;
  delete process.env.JOBSYNC_AI_CONFIG;
  resetAiConfigCache();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedModel === undefined) delete process.env.JOBSYNC_AGENT_MODEL;
  else process.env.JOBSYNC_AGENT_MODEL = savedModel;
  if (savedPath === undefined) delete process.env.JOBSYNC_AI_CONFIG;
  else process.env.JOBSYNC_AI_CONFIG = savedPath;
  resetAiConfigCache();
});

describe("ai-config", () => {
  it("falls back to baked-in defaults when the file has no tuning", () => {
    useConfig({});
    expect(aiCall("composeAnswers")).toEqual({ model: DEFAULT_AGENT_MODEL, maxTokens: 8000 });
    const search = searchAgentConfig();
    expect(search.maxIterations).toBe(40);
    expect(search.toolResultMaxChars).toBe(60000);
    expect(search.maxJobsPerRun).toBe(25);
    expect(search.webSearch).toBe(true);
    expect(search.temperature).toBeUndefined();
  });

  it("applies global and per-call tuning from the file", () => {
    useConfig({
      model: "claude-haiku-4-5",
      calls: {
        tweakAnswer: { model: "claude-opus-4-8", maxTokens: 1000, temperature: 0.3 },
        searchAgent: { maxIterations: 12, webSearch: false },
      },
    });
    // Per-call model + temperature win over the global model.
    expect(aiRequestParams("tweakAnswer")).toEqual({
      model: "claude-opus-4-8",
      max_tokens: 1000,
      temperature: 0.3,
    });
    // Calls without their own model inherit the global one.
    expect(aiCall("composeAnswers").model).toBe("claude-haiku-4-5");
    expect(globalModel()).toBe("claude-haiku-4-5");
    const search = searchAgentConfig();
    expect(search.model).toBe("claude-haiku-4-5");
    expect(search.maxIterations).toBe(12);
    expect(search.webSearch).toBe(false);
    expect(search.maxTokens).toBe(16000); // untouched knob keeps its default
  });

  it("lets JOBSYNC_AGENT_MODEL override every model, including per-call ones", () => {
    useConfig({
      model: "claude-haiku-4-5",
      calls: { tweakAnswer: { model: "claude-opus-4-8" } },
    });
    process.env.JOBSYNC_AGENT_MODEL = "eval-matrix-model";
    expect(aiCall("tweakAnswer").model).toBe("eval-matrix-model");
    expect(aiCall("structureResume").model).toBe("eval-matrix-model");
    expect(searchAgentConfig().model).toBe("eval-matrix-model");
  });

  it("survives an unreadable config file by using defaults", () => {
    const path = join(dir, "broken.json");
    writeFileSync(path, "{ not json");
    process.env.JOBSYNC_AI_CONFIG = path;
    resetAiConfigCache();
    expect(aiCall("structureResume")).toEqual({ model: DEFAULT_AGENT_MODEL, maxTokens: 4000 });
  });
});
