import { indexJobs, listRecentEsJobs, searchEsJobs } from "../lib/elasticsearch.js";
import { validateJobForSync } from "../lib/airtable.js";
import type { ProcessedJob } from "../lib/types.js";
import { coerceProcessedJob } from "./airtable-tools.js";
import { errorResult, textResult, type ToolDefinition } from "./index.js";

// Same job input schema as airtable_upsert_job (ProcessedJob shape).
const jobItemSchema = {
  type: "object" as const,
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
};

export const elasticsearchIndexJobsTool: ToolDefinition = {
  name: "elasticsearch_index_jobs",
  description:
    "Index one or more jobs into the mutu.dev Elasticsearch `jobs_v2` index (the primary job sink). Accepts an array of job objects matching the ProcessedJob shape (positionTitle, company, applyLink, datePosted, jobDescription, etc.). Upserts by a deterministic id derived from applyLink, and (when embeddings are enabled) attaches a 768-dim e5-base-v2 vector for semantic search. Skips jobs that fail validation. Call this after scrape_job_details, in place of airtable_upsert_job, when the sink is elasticsearch. ⚖ [Model hint: sonnet]",
  recommendedModel: "sonnet",
  inputSchema: {
    type: "object",
    properties: {
      jobs: { type: "array", items: jobItemSchema },
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
          indexed: 0,
          rejected: rejected.length,
          rejectedDetails: rejected,
          message: "No valid jobs to index after validation.",
        });
      }

      const result = await indexJobs(valid);
      return textResult({
        indexed: result.indexed,
        failed: result.failed,
        failures: result.errors,
        rejected: rejected.length,
        rejectedDetails: rejected,
      });
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
};

export const elasticsearchListRecentJobsTool: ToolDefinition = {
  name: "elasticsearch_list_recent_jobs",
  description:
    "List recent jobs from the Elasticsearch `jobs_v2` index for dedup lookups. Returns id, title, company, apply_url, and posted_date for postings within the lookback window. Used by the hybrid dedup layer to reconcile the local/Firestore seen-jobs cache against Elasticsearch (the authoritative store now that it is the sink). ⚡ [Model hint: haiku]",
  recommendedModel: "haiku",
  inputSchema: {
    type: "object",
    properties: {
      lookbackHours: { type: "number", description: "Hours to look back. Default 336 (14 days)." },
      maxRecords: { type: "number", description: "Maximum records to return. Default 200." },
    },
    additionalProperties: false,
  },
  handler: async (args) => {
    try {
      const hours = (args.lookbackHours as number | undefined) ?? 336;
      const maxRecords = (args.maxRecords as number | undefined) ?? 200;
      const jobs = await listRecentEsJobs(hours, maxRecords);
      return textResult({ count: jobs.length, jobs });
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
};

export const elasticsearchSearchJobsTool: ToolDefinition = {
  name: "elasticsearch_search_jobs",
  description:
    "Search the Elasticsearch `jobs_v2` index. Defaults to BM25 keyword search across title/company/description; set semantic=true for kNN vector search over the e5-base-v2 embedding (finds conceptually similar roles). Returns matching job documents. ⚖ [Model hint: sonnet]",
  recommendedModel: "sonnet",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query." },
      semantic: { type: "boolean", description: "Use vector/semantic search instead of keyword. Default false." },
      size: { type: "number", description: "Max results. Default 10." },
    },
    required: ["query"],
    additionalProperties: false,
  },
  handler: async (args) => {
    try {
      const query = String(args.query ?? "").trim();
      if (!query) return errorResult("query is required.");
      const hits = await searchEsJobs(query, {
        semantic: Boolean(args.semantic),
        size: (args.size as number | undefined) ?? 10,
      });
      return textResult({
        total: hits.length,
        results: hits.map((h) => ({ id: h._id, ...h._source })),
      });
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
};
