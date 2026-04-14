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

export function registerTools(): ToolDefinition[] {
  return [
    {
      name: "jobsync_ping",
      description:
        "Sanity-check tool. Returns pong with server version. Use to verify the MCP server is connected.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      handler: async () => textResult({ pong: true, version: "0.1.0" }),
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
