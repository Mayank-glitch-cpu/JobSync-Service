// Bridges jobsync's MCP tool registry to Anthropic custom tools so the
// server-side agent can call them in a Messages API loop. The same
// ToolDefinition.handler implementations run; we just translate the schema and
// flatten the ToolResult into text for the model.

import { registerTools, type ToolDefinition } from "../../tools/index.js";

export interface AgentTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolBridge {
  tools: AgentTool[];
  handlers: Map<string, ToolDefinition["handler"]>;
}

// Tools the Search agent is allowed to call. Deliberately excludes the
// auto-apply/browser tools and Airtable writes — Search only discovers, vets,
// dedupes, and lands jobs in the user's pipeline (+ optional ES index).
export const SEARCH_AGENT_TOOLS = [
  "jobsync_ping",
  "profile_read",
  "portals_read",
  "filter_us_location",
  "filter_title_keywords",
  "detect_industry_tags",
  "classify_job_batch",
  "fetch_greenhouse_jobs",
  "fetch_lever_jobs",
  "fetch_ashby_jobs",
  "fetch_workday_jobs",
  "ashby_get_date_posted_batch",
  "scrape_job_details",
  "verify_job_link",
  "verify_job_link_batch",
  "elasticsearch_index_jobs",
  "elasticsearch_list_recent_jobs",
  "cache_is_seen",
  "cache_mark_seen",
  "pipeline_upsert_jobs",
] as const;

/** Build the Anthropic tool list + handler map for the given allowlist. */
export function buildToolBridge(allowed: readonly string[]): ToolBridge {
  const allowSet = new Set(allowed);
  const tools: AgentTool[] = [];
  const handlers = new Map<string, ToolDefinition["handler"]>();

  for (const def of registerTools()) {
    if (!allowSet.has(def.name)) continue;
    tools.push({
      name: def.name,
      // Anthropic caps tool descriptions; keep them tight.
      description: def.description.slice(0, 1024),
      input_schema: def.inputSchema as Record<string, unknown>,
    });
    handlers.set(def.name, def.handler);
  }
  return { tools, handlers };
}

export interface ToolRunResult {
  text: string;
  isError: boolean;
}

/** Execute a bridged tool by name and flatten its ToolResult to text. */
export async function runBridgedTool(
  bridge: ToolBridge,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolRunResult> {
  const handler = bridge.handlers.get(name);
  if (!handler) return { text: `Unknown tool: ${name}`, isError: true };
  try {
    const result = await handler(input ?? {});
    const text = result.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    return { text: text || "(no output)", isError: Boolean(result.isError) };
  } catch (err) {
    return { text: err instanceof Error ? err.message : String(err), isError: true };
  }
}
