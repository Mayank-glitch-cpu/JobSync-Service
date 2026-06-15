// Provider abstraction for the lightweight, per-application LLM calls (compose
// answers, tweak an answer, structure a resume). It lets those calls run against a
// cheaper/free OpenAI-compatible provider during testing without touching the
// Anthropic-specific Search agent.
//
// Selection is ENV-ONLY (nothing is exposed over HTTP):
//   JOBSYNC_LLM_PROVIDER = "anthropic" (default) | "openai"
//   JOBSYNC_LLM_API_KEY  = key for the openai-compatible provider
//   JOBSYNC_LLM_BASE_URL = base url, e.g.
//        Gemini:     https://generativelanguage.googleapis.com/v1beta/openai/
//        Groq:       https://api.groq.com/openai/v1
//        OpenRouter: https://openrouter.ai/api/v1
// The model id comes from ai.config.json / JOBSYNC_AGENT_MODEL per call (so set it
// to a model the chosen provider understands, e.g. "gemini-2.0-flash").

import type Anthropic from "@anthropic-ai/sdk";
import { aiCall, aiRequestParams, type AiCallName } from "./ai-config.js";
import { getAnthropic } from "./anthropic.js";

export type LlmProvider = "anthropic" | "openai";

/** Which provider the lightweight calls use (env-driven; defaults to anthropic). */
export function llmProvider(): LlmProvider {
  return (process.env.JOBSYNC_LLM_PROVIDER ?? "anthropic").toLowerCase() === "openai"
    ? "openai"
    : "anthropic";
}

/** Whether the lightweight LLM calls have a usable backend configured. Unlike
 *  isAgentConfigured() (Anthropic-only, used by the Search agent), this is true when
 *  EITHER the Anthropic key or the openai-compatible provider is set up. */
export function isLlmConfigured(): boolean {
  return llmProvider() === "openai"
    ? Boolean(process.env.JOBSYNC_LLM_API_KEY)
    : Boolean(process.env.ANTHROPIC_API_KEY);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let openaiPromise: Promise<any> | null = null;

async function getOpenAI() {
  const apiKey = process.env.JOBSYNC_LLM_API_KEY;
  if (!apiKey) {
    throw new Error(
      "JOBSYNC_LLM_PROVIDER=openai but JOBSYNC_LLM_API_KEY is not set — cannot reach the free provider.",
    );
  }
  if (!openaiPromise) {
    openaiPromise = import("openai").then(
      ({ default: OpenAI }) =>
        new OpenAI({ apiKey, baseURL: process.env.JOBSYNC_LLM_BASE_URL || undefined }),
    );
  }
  return openaiPromise;
}

let loggedProvider = false;
function logProviderOnce(name: AiCallName, model: string): void {
  if (loggedProvider) return;
  loggedProvider = true;
  console.error(`[llm] provider=${llmProvider()} model=${model} (first call: ${name})`);
}

export interface TextRequest {
  system: string;
  prompt: string;
}

export interface JsonRequest extends TextRequest {
  schema: Record<string, unknown>;
  schemaName?: string;
}

function anthropicText(blocks: Anthropic.Messages.ContentBlock[]): string {
  return blocks
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** A plain text completion (no structured output). */
export async function llmText(name: AiCallName, req: TextRequest): Promise<string> {
  const call = aiCall(name);
  logProviderOnce(name, call.model);
  if (llmProvider() === "openai") {
    const client = await getOpenAI();
    const resp = await client.chat.completions.create({
      model: call.model,
      max_tokens: call.maxTokens,
      ...(call.temperature !== undefined ? { temperature: call.temperature } : {}),
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.prompt },
      ],
    });
    return resp.choices[0]?.message?.content ?? "";
  }
  const client = await getAnthropic();
  const resp = await client.messages.create({
    ...aiRequestParams(name),
    system: req.system,
    messages: [{ role: "user", content: req.prompt }],
  });
  return anthropicText(resp.content);
}

/** A completion constrained to a JSON schema. Returns the raw JSON string (the
 *  caller JSON.parses it), matching the existing Anthropic call sites. */
export async function llmJson(name: AiCallName, req: JsonRequest): Promise<string> {
  const call = aiCall(name);
  logProviderOnce(name, call.model);
  if (llmProvider() === "openai") {
    const client = await getOpenAI();
    const resp = await client.chat.completions.create({
      model: call.model,
      max_tokens: call.maxTokens,
      ...(call.temperature !== undefined ? { temperature: call.temperature } : {}),
      response_format: {
        type: "json_schema",
        json_schema: { name: req.schemaName ?? "result", schema: req.schema, strict: true },
      },
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.prompt },
      ],
    });
    return resp.choices[0]?.message?.content ?? "";
  }
  const client = await getAnthropic();
  const resp = await client.messages.create({
    ...aiRequestParams(name),
    system: req.system,
    output_config: { format: { type: "json_schema", schema: req.schema } },
    messages: [{ role: "user", content: req.prompt }],
  });
  return anthropicText(resp.content);
}
