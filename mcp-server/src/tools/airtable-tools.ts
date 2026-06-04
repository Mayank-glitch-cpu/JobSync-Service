import { loadConfig, saveConfig } from "../config.js";
import {
  listRecentAirtableJobs,
  mapToAirtableRecord,
  upsertJobs,
  validateJobForSync,
  type AirtableCredentials,
} from "../lib/airtable.js";
import { createJobSyncBase, listBases } from "../lib/airtable-meta.js";
import type { ProcessedJob } from "../lib/types.js";
import { errorResult, textResult, type ToolDefinition } from "./index.js";

function credsFromConfig(): AirtableCredentials {
  const cfg = loadConfig();
  return {
    pat: cfg.airtable.pat,
    baseId: cfg.airtable.baseId,
    tableName: cfg.airtable.tableName,
  };
}

function coerceProcessedJob(raw: Record<string, unknown>): ProcessedJob {
  return {
    id: String(raw.id ?? ""),
    positionTitle: String(raw.positionTitle ?? ""),
    company: String(raw.company ?? ""),
    location: (raw.location as string | null) ?? null,
    applyLink: (raw.applyLink as string | null) ?? null,
    datePosted: (raw.datePosted as string | null) ?? null,
    salary: (raw.salary as string | null) ?? null,
    rawFields: (raw.rawFields as Record<string, string>) ?? {},
    jobDescription: (raw.jobDescription as string | null) ?? null,
    scrapeStatus: (raw.scrapeStatus as ProcessedJob["scrapeStatus"]) ?? "success",
    workModel: (raw.workModel as ProcessedJob["workModel"]) ?? null,
    industry: (raw.industry as string | null) ?? null,
    h1bSponsored: Boolean(raw.h1bSponsored ?? false),
    qualifications: (raw.qualifications as string | null) ?? null,
    jobBoard: (raw.jobBoard as ProcessedJob["jobBoard"]) ?? null,
    tags: (raw.tags as string[]) ?? [],
    isNewGrad: Boolean(raw.isNewGrad ?? false),
    isInternship: Boolean(raw.isInternship ?? false),
    aiConfidence: (raw.aiConfidence as number | null) ?? null,
    aiProcessed: Boolean(raw.aiProcessed ?? false),
  };
}

export const airtableUpsertJobTool: ToolDefinition = {
  name: "airtable_upsert_job",
  description:
    "Create one or more job records in the user's Airtable base. Accepts an array of job objects matching the ProcessedJob shape (positionTitle, company, applyLink, datePosted, etc.). Skips jobs that fail validation (missing critical fields or placeholder values) and returns a summary with created record IDs, rejected jobs, and Airtable errors. ⚖ [Model hint: sonnet]",
  recommendedModel: "sonnet",
  inputSchema: {
    type: "object",
    properties: {
      jobs: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            positionTitle: { type: "string" },
            company: { type: "string" },
            location: { type: ["string", "null"] },
            applyLink: { type: ["string", "null"] },
            datePosted: { type: ["string", "null"], description: "YYYY-MM-DD" },
            salary: { type: ["string", "null"] },
            jobDescription: { type: ["string", "null"] },
            workModel: { type: ["string", "null"], enum: ["Onsite", "Remote", "Hybrid", null] },
            industry: { type: ["string", "null"] },
            h1bSponsored: { type: "boolean" },
            qualifications: { type: ["string", "null"] },
            jobBoard: { type: ["string", "null"] },
            tags: { type: "array", items: { type: "string" } },
            isNewGrad: { type: "boolean" },
            isInternship: { type: "boolean" },
          },
          required: ["positionTitle", "company"],
          additionalProperties: true,
        },
      },
    },
    required: ["jobs"],
    additionalProperties: false,
  },
  handler: async (args) => {
    try {
      const rawJobs = (args.jobs as Array<Record<string, unknown>>) ?? [];
      const coerced = rawJobs.map(coerceProcessedJob);

      const valid: ProcessedJob[] = [];
      const rejected: Array<{ company: string; title: string; reasons: string[] }> = [];
      for (const job of coerced) {
        const v = validateJobForSync(job);
        if (v.valid) valid.push(job);
        else rejected.push({ company: job.company, title: job.positionTitle, reasons: v.reasons });
      }

      if (valid.length === 0) {
        return textResult({
          created: 0,
          rejected: rejected.length,
          rejectedDetails: rejected,
          failed: 0,
          message: "No valid jobs to sync after validation.",
        });
      }

      const result = await upsertJobs(valid, credsFromConfig());
      return textResult({
        created: result.created.length,
        createdRecordIds: result.created.map((j) => j.airtableRecordId),
        failed: result.failed.length,
        failures: result.failed.map((f) => ({
          company: f.job.company,
          title: f.job.positionTitle,
          error: f.error,
        })),
        rejected: rejected.length,
        rejectedDetails: rejected,
      });
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
};

export const airtableListRecentJobsTool: ToolDefinition = {
  name: "airtable_list_recent_jobs",
  description:
    "List recent job records from the user's Airtable base for dedup lookups. Returns the Apply Link, Company, Position Title, and Date for records created/modified in the lookback window. Used by the hybrid dedup layer to reconcile the local SQLite cache against Airtable's source of truth. ⚡ [Model hint: haiku]",
  recommendedModel: "haiku",
  inputSchema: {
    type: "object",
    properties: {
      lookbackDays: { type: "number", description: "Days to look back. Default 14." },
      maxRecords: { type: "number", description: "Maximum records to return. Default 500." },
    },
    additionalProperties: false,
  },
  handler: async (args) => {
    try {
      const lookback = (args.lookbackDays as number | undefined) ?? 14;
      const maxRecords = (args.maxRecords as number | undefined) ?? 500;
      const cutoff = new Date(Date.now() - lookback * 24 * 60 * 60 * 1000)
        .toISOString()
        .split("T")[0];

      const rows = await listRecentAirtableJobs(credsFromConfig(), {
        cutoffDate: cutoff ?? new Date().toISOString().split("T")[0]!,
        maxRecords,
      });

      return textResult({ count: rows.length, jobs: rows });
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
};

export const airtableGetSchemaTool: ToolDefinition = {
  name: "airtable_get_schema",
  description:
    "Return the field map this server writes to Airtable (the expected schema of the user's table). Use to diagnose schema-drift errors or to show the user which columns the server expects. ⚡ [Model hint: haiku]",
  recommendedModel: "haiku",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  handler: async () => {
    const sample: ProcessedJob = {
      id: "sample",
      positionTitle: "Software Engineer",
      company: "Acme",
      location: "San Francisco, CA",
      applyLink: "https://example.com/apply",
      datePosted: "2026-04-12",
      salary: "$100k-$120k",
      rawFields: {},
      jobDescription: "...",
      scrapeStatus: "success",
      workModel: "Remote",
      industry: "Software Engineering",
      h1bSponsored: true,
      qualifications: "BS degree",
      jobBoard: "Greenhouse",
      tags: ["YC"],
      isNewGrad: true,
      isInternship: false,
      aiConfidence: 0.9,
      aiProcessed: true,
    };
    const cfg = loadConfig();
    return textResult({
      baseId: cfg.airtable.baseId,
      tableName: cfg.airtable.tableName,
      exampleRecord: mapToAirtableRecord(sample),
    });
  },
};

export const airtableListBasesTool: ToolDefinition = {
  name: "airtable_list_bases",
  description:
    "List all Airtable bases the PAT has access to. Useful during onboarding to help the user pick an existing base, or to confirm a newly created one. ⚡ [Model hint: haiku]",
  recommendedModel: "haiku",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async () => {
    try {
      const cfg = loadConfig();
      if (!cfg.airtable.pat) return errorResult("No Airtable PAT in config.");
      const bases = await listBases(cfg.airtable.pat);
      return textResult({ count: bases.length, bases });
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
};

export const airtableCreateBaseTool: ToolDefinition = {
  name: "airtable_create_base",
  description:
    "Create a new Airtable base with the JobSync schema (Jobs table + all fields the server writes). Requires a PAT with the `schema.bases:write` scope AND the target workspace ID (from the Airtable URL when viewing a workspace: airtable.com/{wspID}/...). On success, updates ~/.jobsync/config.json with the new baseId so subsequent runs use it. ⚡ [Model hint: haiku]",
  recommendedModel: "haiku",
  inputSchema: {
    type: "object",
    properties: {
      workspaceId: {
        type: "string",
        description: "Airtable workspace ID (starts with `wsp...`). Find it at https://airtable.com/ when viewing a workspace.",
      },
      name: { type: "string", description: "Base name. Default: JobSync." },
      setAsActive: {
        type: "boolean",
        description: "Write the new baseId + table name into config.json. Default true.",
      },
    },
    required: ["workspaceId"],
    additionalProperties: false,
  },
  handler: async (args) => {
    try {
      const cfg = loadConfig();
      if (!cfg.airtable.pat) return errorResult("No Airtable PAT in config. Run `jobsync-mcp init` first.");
      const workspaceId = String(args.workspaceId);
      const name = (args.name as string | undefined) ?? "JobSync";
      const result = await createJobSyncBase(cfg.airtable.pat, workspaceId, name);
      const setAsActive = (args.setAsActive as boolean | undefined) ?? true;
      if (setAsActive) {
        cfg.airtable.baseId = result.id;
        cfg.airtable.tableName = "Jobs";
        saveConfig(cfg);
      }
      return textResult({
        created: result,
        activatedInConfig: setAsActive,
        baseUrl: `https://airtable.com/${result.id}`,
      });
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
};
