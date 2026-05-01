import { brandPrefix } from "../lib/brand.js";
import { isBrandedOutput } from "../config.js";

declare const __JOBSYNC_VERSION__: string;

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolResult {
  content: Array<ContentBlock>;
  isError?: boolean;
}

export type ModelTier = "haiku" | "sonnet" | "opus";

export interface ToolDefinition {
  name: string;
  description: string;
  /** Recommended Claude model tier for this tool call. Surfaced in descriptions and via suggest_model_for_query. */
  recommendedModel?: ModelTier;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

import {
  classifyJobBatchTool,
  detectIndustryTagsTool,
  filterTitleKeywordsTool,
  filterUsLocationTool,
} from "./filter-tools.js";
import {
  airtableCreateBaseTool,
  airtableGetSchemaTool,
  airtableListBasesTool,
  airtableListRecentJobsTool,
  airtableUpsertJobTool,
} from "./airtable-tools.js";
import { markdownAppendJobsTool } from "./markdown-tools.js";
import {
  cacheIsSeenTool,
  cacheMarkSeenTool,
  cachePruneTool,
} from "./cache-tools.js";
import {
  profileParseResumeTool,
  profileReadTool,
  profileUpdateRolesTool,
  profileWriteFileTool,
} from "./profile-tools.js";
import {
  fetchAshbyTool,
  fetchGreenhouseTool,
  fetchLeverTool,
  fetchWorkdayTool,
} from "./fast-path-tools.js";
import {
  verifyJobLinkTool,
  verifyJobLinkBatchTool,
} from "./link-check-tools.js";
import {
  ashbyGetDatePostedTool,
  ashbyGetDatePostedBatchTool,
} from "./ashby-date-tools.js";
import { suggestModelForQueryTool } from "./model-advisor-tool.js";
import {
  portalsMasterListTool,
  portalsReadTool,
  portalsWriteTool,
} from "./portals-tools.js";
import {
  pipelineGetStatusTool,
  pipelineMarkAppliedTool,
  pipelineUpdateStatusTool,
  pipelineUpsertJobsTool,
} from "./pipeline-tools.js";
import {
  applyInspectFormTool,
  applyLoadStateTool,
  applySaveDraftTool,
  applySubmitFormTool,
  profileReadPersonalTool,
  profileWritePersonalTool,
} from "./apply-tools.js";

function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => v.split(".").map(Number);
  const [lMaj, lMin, lPat] = parse(latest);
  const [cMaj, cMin, cPat] = parse(current);
  if (lMaj !== cMaj) return (lMaj ?? 0) > (cMaj ?? 0);
  if (lMin !== cMin) return (lMin ?? 0) > (cMin ?? 0);
  return (lPat ?? 0) > (cPat ?? 0);
}

// Rough token estimate: ~4 chars per token (good enough for display metadata).
function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

// Wraps a tool handler to append _tokenUsage to every result's last JSON block.
function withTokenMeta(tool: ToolDefinition): ToolDefinition {
  const orig = tool.handler;
  return {
    ...tool,
    handler: async (args) => {
      const tokensIn = estimateTokens(args);
      const result = await orig(args);
      const outputText = result.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");
      const tokensOut = estimateTokens(outputText);

      const meta = {
        estimatedIn: tokensIn,
        estimatedOut: tokensOut,
        totalEstimated: tokensIn + tokensOut,
        recommendedModel: tool.recommendedModel ?? "haiku",
      };

      // Inject into the last text block if it is JSON; otherwise append plain text.
      const blocks = result.content;
      const lastTextIdx = blocks.reduce<number>(
        (acc, c, i) => (c.type === "text" ? i : acc),
        -1,
      );
      const last = lastTextIdx >= 0 ? (blocks[lastTextIdx] as { type: "text"; text: string }) : undefined;
      try {
        if (!last) throw new Error("empty");
        const parsed: Record<string, unknown> = JSON.parse(last.text);
        parsed._tokenUsage = meta;
        return {
          ...result,
          content: [
            ...blocks.slice(0, lastTextIdx),
            { type: "text" as const, text: JSON.stringify(parsed, null, 2) },
            ...blocks.slice(lastTextIdx + 1),
          ],
        };
      } catch {
        return {
          ...result,
          content: [
            ...blocks,
            {
              type: "text" as const,
              text: `📊 tokens ~${tokensIn} in · ~${tokensOut} out · model hint: ${meta.recommendedModel}`,
            },
          ],
        };
      }
    },
  };
}

export function registerTools(): ToolDefinition[] {
  return [
    {
      name: "jobsync_ping",
      description:
        "Sanity-check tool. Returns pong and the running server version. " +
        "Call this at the start of every workflow to confirm the MCP server is live. ⚡ [Model hint: haiku]",
      recommendedModel: "haiku" as const,
      inputSchema: {
        type: "object" as const,
        properties: {},
        additionalProperties: false,
      },
      handler: async () => {
        const CURRENT = __JOBSYNC_VERSION__;
        let latestVersion: string | null = null;
        let updateAvailable = false;
        try {
          const res = await fetch("https://registry.npmjs.org/jobsync-mcp/latest", {
            headers: { accept: "application/json" },
            signal: AbortSignal.timeout(4000),
          });
          if (res.ok) {
            const data = (await res.json()) as { version: string };
            latestVersion = data.version;
            updateAvailable = latestVersion !== CURRENT && isNewer(latestVersion, CURRENT);
          }
        } catch {
          // registry unreachable — non-fatal
        }
        return textResult({
          pong: true,
          version: CURRENT,
          latestVersion,
          updateAvailable,
          ...(updateAvailable && {
            updateMessage: `New version ${latestVersion} available. Run: npm i -g jobsync-mcp@latest`,
            changelog: `https://github.com/Mayank-glitch-cpu/JobSync-Service/releases/tag/v${latestVersion}`,
          }),
        });
      },
    },
    filterUsLocationTool,
    filterTitleKeywordsTool,
    detectIndustryTagsTool,
    classifyJobBatchTool,
    airtableUpsertJobTool,
    airtableListRecentJobsTool,
    airtableGetSchemaTool,
    airtableListBasesTool,
    airtableCreateBaseTool,
    markdownAppendJobsTool,
    cacheIsSeenTool,
    cacheMarkSeenTool,
    cachePruneTool,
    profileReadTool,
    profileWriteFileTool,
    profileUpdateRolesTool,
    profileParseResumeTool,
    fetchGreenhouseTool,
    fetchLeverTool,
    fetchAshbyTool,
    fetchWorkdayTool,
    verifyJobLinkTool,
    verifyJobLinkBatchTool,
    ashbyGetDatePostedTool,
    ashbyGetDatePostedBatchTool,
    suggestModelForQueryTool,
    pipelineUpsertJobsTool,
    pipelineMarkAppliedTool,
    pipelineUpdateStatusTool,
    pipelineGetStatusTool,
    portalsReadTool,
    portalsWriteTool,
    portalsMasterListTool,
    profileReadPersonalTool,
    profileWritePersonalTool,
    applyInspectFormTool,
    applyLoadStateTool,
    applySaveDraftTool,
    applySubmitFormTool,
  ].map(withTokenMeta);
}

function withBrand(content: Array<ContentBlock>): Array<ContentBlock> {
  if (!isBrandedOutput()) return content;
  return [{ type: "text", text: brandPrefix() }, ...content];
}

export function textResult(obj: unknown): ToolResult {
  return {
    content: withBrand([{ type: "text", text: JSON.stringify(obj, null, 2) }]),
  };
}

export function errorResult(message: string): ToolResult {
  return {
    content: withBrand([{ type: "text", text: message }]),
    isError: true,
  };
}
