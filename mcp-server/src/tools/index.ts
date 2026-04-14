export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
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
} from "./fast-path-tools.js";
import {
  verifyJobLinkTool,
  verifyJobLinkBatchTool,
} from "./link-check-tools.js";

function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => v.split(".").map(Number);
  const [lMaj, lMin, lPat] = parse(latest);
  const [cMaj, cMin, cPat] = parse(current);
  if (lMaj !== cMaj) return (lMaj ?? 0) > (cMaj ?? 0);
  if (lMin !== cMin) return (lMin ?? 0) > (cMin ?? 0);
  return (lPat ?? 0) > (cPat ?? 0);
}

export function registerTools(): ToolDefinition[] {
  return [
    {
      name: "jobsync_ping",
      description:
        "Sanity-check tool. Returns pong, the running server version, and whether a newer version is available on npm. " +
        "Always call this at the start of a workflow. If updateAvailable is true, tell the user to run `npm i -g jobsync-mcp@latest` before proceeding.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      handler: async () => {
        const CURRENT = "0.2.6";
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
    verifyJobLinkTool,
    verifyJobLinkBatchTool,
  ];
}

export function textResult(obj: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
  };
}

export function errorResult(message: string): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}
