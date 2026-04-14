import { loadConfig } from "../config.js";
import { appendJobsToMarkdown } from "../lib/markdown-sink.js";
import type { ProcessedJob } from "../lib/types.js";
import { errorResult, textResult, type ToolDefinition } from "./index.js";

export const markdownAppendJobsTool: ToolDefinition = {
  name: "markdown_append_jobs",
  description:
    "Append processed jobs as rows to the markdown log at config.markdownPath (default ~/.jobsync/jobs.md). Alternative to Airtable when the user hasn't configured a base. Accepts ProcessedJob objects with the same shape `airtable_upsert_job` takes. Optional `path` override.",
  inputSchema: {
    type: "object",
    properties: {
      jobs: {
        type: "array",
        items: { type: "object", additionalProperties: true },
        description: "ProcessedJob records to append.",
      },
      path: { type: "string", description: "Override the default markdown path for this call." },
    },
    required: ["jobs"],
    additionalProperties: false,
  },
  handler: async (args) => {
    try {
      const jobs = (args.jobs as ProcessedJob[]) ?? [];
      const path = (args.path as string | undefined) ?? loadConfig().markdownPath;
      const n = appendJobsToMarkdown(path, jobs);
      return textResult({ appended: n, path });
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
};
