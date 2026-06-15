// One tweakable config for every AI (Anthropic) call the agent runtime makes.
//
// Edit mcp-server/ai.config.json to tune models, token budgets, temperature, and
// the Search agent's loop budgets without touching agent code. Knob precedence
// (highest wins):
//   1. JOBSYNC_AGENT_MODEL env var       (model only — the deploy/eval-matrix override)
//   2. ai.config.json "calls.<name>"     (per-call tuning)
//   3. ai.config.json top-level "model"
//   4. Baked-in defaults below
// JOBSYNC_AI_CONFIG=<absolute path> points the loader at an alternate JSON file.
// The file is read once per process and cached (Cloud Run filesystems are
// immutable anyway); call resetAiConfigCache() in tests to re-read.
//
// PROVIDER: the model id resolved here is sent to whichever provider lib/agent/llm.ts
// selects. By default that's Anthropic. Set JOBSYNC_LLM_PROVIDER=openai (+ key + base
// url) to route the lightweight Auto-Apply / resume calls to a cheaper/free
// OpenAI-compatible provider for testing — in that case set the model below to one
// that provider understands (e.g. "gemini-2.0-flash"). The Search agent always uses
// Anthropic regardless.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_AGENT_MODEL = "claude-sonnet-4-6";

/** Knobs every LLM call understands. */
export interface CallTuning {
  /** Anthropic model id; falls back to the global model. */
  model?: string;
  maxTokens?: number;
  /** 0–1; omitted → API default. */
  temperature?: number;
}

/** Extra budgets only the Search agent's tool-use loop understands. */
export interface SearchTuning extends CallTuning {
  /** Hard cap on messages.create round-trips per run. */
  maxIterations?: number;
  /** Truncation cap applied to each tool result fed back to the model. */
  toolResultMaxChars?: number;
  /** Soft cap surfaced to the model in its system prompt. */
  maxJobsPerRun?: number;
  /** Expose the Anthropic web_search server tool to the agent. */
  webSearch?: boolean;
}

interface AiConfigFile {
  model?: string;
  calls?: {
    searchAgent?: SearchTuning;
    composeAnswers?: CallTuning;
    tweakAnswer?: CallTuning;
    structureResume?: CallTuning;
  };
}

const DEFAULTS = {
  searchAgent: {
    maxTokens: 16000,
    maxIterations: 40,
    toolResultMaxChars: 60000,
    maxJobsPerRun: 25,
    webSearch: true,
  },
  composeAnswers: { maxTokens: 8000 },
  tweakAnswer: { maxTokens: 2000 },
  structureResume: { maxTokens: 4000 },
} as const;

export type AiCallName = keyof typeof DEFAULTS;

let cached: AiConfigFile | null | undefined;

function findConfigFile(): string | undefined {
  if (process.env.JOBSYNC_AI_CONFIG) return process.env.JOBSYNC_AI_CONFIG;
  // Walk up from this module — src/lib/agent in dev/tests, dist in the bundle and
  // the container — so the same lookup finds mcp-server/ai.config.json everywhere.
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, "ai.config.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const cwdCandidate = join(process.cwd(), "ai.config.json");
  return existsSync(cwdCandidate) ? cwdCandidate : undefined;
}

function fileConfig(): AiConfigFile {
  if (cached !== undefined) return cached ?? {};
  const path = findConfigFile();
  if (!path) {
    cached = null;
    return {};
  }
  try {
    cached = JSON.parse(readFileSync(path, "utf8")) as AiConfigFile;
  } catch (err) {
    console.error(
      `[ai-config] Could not read ${path} — using baked-in defaults:`,
      err instanceof Error ? err.message : err,
    );
    cached = null;
  }
  return cached ?? {};
}

/** Forget the cached config file so the next call re-reads it (test hook). */
export function resetAiConfigCache(): void {
  cached = undefined;
}

/** The model used when a call has no per-call override. */
export function globalModel(): string {
  return process.env.JOBSYNC_AGENT_MODEL ?? fileConfig().model ?? DEFAULT_AGENT_MODEL;
}

export interface ResolvedCall {
  model: string;
  maxTokens: number;
  temperature?: number;
}

export function aiCall(name: AiCallName): ResolvedCall {
  const tuned: CallTuning = fileConfig().calls?.[name] ?? {};
  return {
    model: process.env.JOBSYNC_AGENT_MODEL ?? tuned.model ?? fileConfig().model ?? DEFAULT_AGENT_MODEL,
    maxTokens: tuned.maxTokens ?? DEFAULTS[name].maxTokens,
    ...(tuned.temperature !== undefined ? { temperature: tuned.temperature } : {}),
  };
}

/** Request params in API shape — spread directly into client.messages.create(). */
export function aiRequestParams(name: AiCallName): { model: string; max_tokens: number; temperature?: number } {
  const c = aiCall(name);
  return {
    model: c.model,
    max_tokens: c.maxTokens,
    ...(c.temperature !== undefined ? { temperature: c.temperature } : {}),
  };
}

export interface SearchAgentConfig extends ResolvedCall {
  maxIterations: number;
  toolResultMaxChars: number;
  maxJobsPerRun: number;
  webSearch: boolean;
}

export function searchAgentConfig(): SearchAgentConfig {
  const tuned: SearchTuning = fileConfig().calls?.searchAgent ?? {};
  const d = DEFAULTS.searchAgent;
  return {
    ...aiCall("searchAgent"),
    maxIterations: tuned.maxIterations ?? d.maxIterations,
    toolResultMaxChars: tuned.toolResultMaxChars ?? d.toolResultMaxChars,
    maxJobsPerRun: tuned.maxJobsPerRun ?? d.maxJobsPerRun,
    webSearch: tuned.webSearch ?? d.webSearch,
  };
}
