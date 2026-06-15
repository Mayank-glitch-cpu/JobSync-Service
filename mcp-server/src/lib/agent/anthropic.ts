// Anthropic client for the server-side agent runtime. One shared deployment key
// (ANTHROPIC_API_KEY); models + per-call tuning live in ai.config.json (see
// ai-config.ts), with JOBSYNC_AGENT_MODEL as the deploy-level model override.
// Lazily imported so installs that never run an agent don't pay the dependency.

import type Anthropic from "@anthropic-ai/sdk";
import { globalModel } from "./ai-config.js";

export { DEFAULT_AGENT_MODEL } from "./ai-config.js";

export function agentModel(): string {
  return globalModel();
}

export function isAgentConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

let clientPromise: Promise<Anthropic> | null = null;

export function getAnthropic(): Promise<Anthropic> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Promise.reject(
      new Error("ANTHROPIC_API_KEY is not set — the Search agent runtime is unavailable."),
    );
  }
  if (!clientPromise) {
    clientPromise = import("@anthropic-ai/sdk").then(({ default: AnthropicCtor }) => {
      return new AnthropicCtor({ apiKey: process.env.ANTHROPIC_API_KEY });
    });
  }
  return clientPromise;
}
