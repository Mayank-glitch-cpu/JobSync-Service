// Anthropic client for the server-side agent runtime. One shared deployment key
// (ANTHROPIC_API_KEY); the model is configurable via JOBSYNC_AGENT_MODEL and
// defaults to claude-sonnet-4-6 (cheaper/faster for the high-volume scrape loop).
// Lazily imported so installs that never run an agent don't pay the dependency.

import type Anthropic from "@anthropic-ai/sdk";

export const DEFAULT_AGENT_MODEL = "claude-sonnet-4-6";

export function agentModel(): string {
  return process.env.JOBSYNC_AGENT_MODEL ?? DEFAULT_AGENT_MODEL;
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
