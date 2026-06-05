import {
  MASTER_COMPANY_LIST,
  getPortalsPath,
  readPortals,
  writePortals,
} from "../lib/portals.js";
import { errorResult, textResult, type ToolDefinition } from "./index.js";

export const portalsReadTool: ToolDefinition = {
  name: "portals_read",
  description:
    "Read the user's portal scanner configuration from ~/.jobsync/portals.yml. " +
    "Returns the raw YAML content plus an exists flag. " +
    "The scrape workflow uses this to drive search_queries and tracked_companies. " +
    "⚡ [Model hint: haiku]",
  recommendedModel: "haiku",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  handler: async () => {
    try {
      const result = await readPortals();
      return textResult({ ...result });
    } catch (err) {
      return errorResult(String(err));
    }
  },
};

export const portalsWriteTool: ToolDefinition = {
  name: "portals_write",
  description:
    "Write (overwrite) the portal scanner configuration at ~/.jobsync/portals.yml. " +
    "Pass the full YAML content as a string. " +
    "Called during onboarding to save the personalized portals config. " +
    "Also accessible to the user for direct edits via the onboard prompt. " +
    "⚡ [Model hint: haiku]",
  recommendedModel: "haiku",
  inputSchema: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "Full YAML content to write to portals.yml.",
      },
    },
    required: ["content"],
    additionalProperties: false,
  },
  handler: async (args) => {
    try {
      const content = String(args.content ?? "");
      if (!content.trim()) return errorResult("content must not be empty.");
      const result = await writePortals(content);
      return textResult({ success: true, path: result.path, bytes: content.length });
    } catch (err) {
      return errorResult(String(err));
    }
  },
};

export const portalsMasterListTool: ToolDefinition = {
  name: "portals_master_list",
  description:
    "Return the built-in master company list (YAML snippet) that covers ~60 companies " +
    "across AI labs, developer tools, voice AI, SaaS, and fintech. " +
    "Used during onboarding to let Claude select relevant companies for the user's portals.yml. " +
    "⚡ [Model hint: haiku]",
  recommendedModel: "haiku",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  handler: async () => {
    try {
      return textResult({ masterCompanyList: MASTER_COMPANY_LIST, path: getPortalsPath() });
    } catch (err) {
      return errorResult(String(err));
    }
  },
};
