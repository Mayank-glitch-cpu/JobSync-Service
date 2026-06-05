import {
  type ApplicationStatus,
  getPipelineGrouped,
  getPipelinePath,
  markApplied,
  updateStatuses,
  upsertPipelineEntries,
} from "../lib/pipeline.js";
import { errorResult, textResult, type ToolDefinition } from "./index.js";

export const pipelineUpsertJobsTool: ToolDefinition = {
  name: "pipeline_upsert_jobs",
  description:
    "Add or update jobs in the application pipeline TSV at ~/.jobsync/pipeline.tsv. " +
    "Call this after fit analysis to persist all scored roles. " +
    "For existing entries the status / appliedAt / notes are preserved; only metadata fields are refreshed. " +
    "⚡ [Model hint: haiku]",
  recommendedModel: "haiku",
  inputSchema: {
    type: "object",
    properties: {
      jobs: {
        type: "array",
        description: "Jobs to add or update in the pipeline.",
        items: {
          type: "object",
          properties: {
            id:            { type: "string", description: "Stable job id (from scraper or ATS)." },
            positionTitle: { type: "string" },
            company:       { type: "string" },
            location:      { type: "string" },
            applyLink:     { type: "string", description: "Primary dedup key." },
            datePosted:    { type: "string", description: "YYYY-MM-DD." },
            industry:      { type: "string" },
            tags:          { type: "string", description: "Comma-separated tags, e.g. 'FAANG+,YC'." },
            fitScore:      { type: "string", description: "Score 1–10 as a string." },
          },
          required: ["positionTitle", "company", "applyLink"],
        },
      },
    },
    required: ["jobs"],
    additionalProperties: false,
  },
  handler: async (args) => {
    try {
      const jobs = args.jobs as Array<{
        positionTitle: string;
        company: string;
        applyLink: string;
        [key: string]: string | undefined;
      }>;
      const result = await upsertPipelineEntries(jobs);
      return textResult({ success: true, ...result, pipelinePath: getPipelinePath() });
    } catch (err) {
      return errorResult(String(err));
    }
  },
};

export const pipelineMarkAppliedTool: ToolDefinition = {
  name: "pipeline_mark_applied",
  description:
    "Mark one or more jobs as 'applied' in the pipeline by their exact apply link URLs. " +
    "Call this whenever the user confirms they have submitted an application for a role. " +
    "Sets status=applied and stamps appliedAt with today's date. ⚡ [Model hint: haiku]",
  recommendedModel: "haiku",
  inputSchema: {
    type: "object",
    properties: {
      applyLinks: {
        type: "array",
        items: { type: "string" },
        description: "Exact apply link URLs of jobs the user has applied to.",
      },
    },
    required: ["applyLinks"],
    additionalProperties: false,
  },
  handler: async (args) => {
    try {
      const result = await markApplied(args.applyLinks as string[]);
      return textResult({ success: true, ...result });
    } catch (err) {
      return errorResult(String(err));
    }
  },
};

export const pipelineUpdateStatusTool: ToolDefinition = {
  name: "pipeline_update_status",
  description:
    "Update the status and/or notes of one or more pipeline entries. " +
    "Valid statuses: pending | applied | interviewing | offer | rejected | withdrawn. " +
    "Identify jobs by their applyLink or id. ⚡ [Model hint: haiku]",
  recommendedModel: "haiku",
  inputSchema: {
    type: "object",
    properties: {
      updates: {
        type: "array",
        items: {
          type: "object",
          properties: {
            applyLink: { type: "string", description: "Apply link URL — primary lookup key." },
            id:        { type: "string", description: "Job id — fallback if applyLink unavailable." },
            status: {
              type: "string",
              enum: ["pending", "applied", "interviewing", "offer", "rejected", "withdrawn"],
            },
            notes: { type: "string", description: "Optional free-text note to attach." },
          },
          required: ["status"],
        },
        description: "Each item must have status plus at least one of applyLink or id.",
      },
    },
    required: ["updates"],
    additionalProperties: false,
  },
  handler: async (args) => {
    try {
      const updates = args.updates as Array<{
        applyLink?: string;
        id?: string;
        status: ApplicationStatus;
        notes?: string;
      }>;
      const result = await updateStatuses(updates);
      return textResult({ success: true, ...result });
    } catch (err) {
      return errorResult(String(err));
    }
  },
};

export const pipelineGetStatusTool: ToolDefinition = {
  name: "pipeline_get_status",
  description:
    "Read the full application pipeline from ~/.jobsync/pipeline.tsv. " +
    "Returns a summary (counts per stage) plus entries grouped by status. " +
    "Optionally filter to specific statuses. Use this to power the pipeline dashboard. " +
    "⚡ [Model hint: haiku]",
  recommendedModel: "haiku",
  inputSchema: {
    type: "object",
    properties: {
      statusFilter: {
        type: "array",
        items: {
          type: "string",
          enum: ["pending", "applied", "interviewing", "offer", "rejected", "withdrawn"],
        },
        description: "If provided, only return entries with these statuses. Omit for all.",
      },
    },
    additionalProperties: false,
  },
  handler: async (args) => {
    try {
      const filter = args.statusFilter as ApplicationStatus[] | undefined;
      const result = await getPipelineGrouped(filter);
      return textResult(result);
    } catch (err) {
      return errorResult(String(err));
    }
  },
};
