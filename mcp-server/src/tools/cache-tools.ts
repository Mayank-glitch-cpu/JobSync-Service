import {
  cacheSize,
  isSeen,
  markSeen,
  markSeenBatch,
  pruneOlderThan,
} from "../lib/cache.js";
import { errorResult, textResult, type ToolDefinition } from "./index.js";

export const cacheIsSeenTool: ToolDefinition = {
  name: "cache_is_seen",
  description:
    "Check whether a job URL has already been seen (cache backend: local SQLite or Firestore). Returns { seen: boolean, record?: {...} }. On a cache miss, the caller should fall back to `elasticsearch_list_recent_jobs` (or `airtable_list_recent_jobs` when the sink is Airtable) to reconcile against the authoritative store. Accepts a single applyLink or a batch. ⚡ [Model hint: haiku]",
  recommendedModel: "haiku",
  inputSchema: {
    type: "object",
    properties: {
      applyLink: { type: "string", description: "Single URL to check." },
      applyLinks: {
        type: "array",
        items: { type: "string" },
        description: "Batch of URLs to check. Returns parallel array of results.",
      },
    },
    additionalProperties: false,
  },
  handler: async (args) => {
    try {
      if (args.applyLink) {
        const link = String(args.applyLink);
        const record = await isSeen(link);
        return textResult({ applyLink: link, seen: record !== null, record });
      }
      const links = (args.applyLinks as string[]) ?? [];
      const results = await Promise.all(
        links.map(async (link) => {
          const record = await isSeen(link);
          return { applyLink: link, seen: record !== null, record };
        }),
      );
      return textResult({ total: results.length, seen: results.filter((r) => r.seen).length, results });
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
};

export const cacheMarkSeenTool: ToolDefinition = {
  name: "cache_mark_seen",
  description:
    "Record one or more jobs as seen in the local SQLite cache. Call this after successful `airtable_upsert_job` so the next run skips duplicates without round-tripping Airtable. ⚡ [Model hint: haiku]",
  recommendedModel: "haiku",
  inputSchema: {
    type: "object",
    properties: {
      jobs: {
        type: "array",
        items: {
          type: "object",
          properties: {
            applyLink: { type: "string" },
            company: { type: "string" },
            positionTitle: { type: "string" },
          },
          required: ["applyLink", "company", "positionTitle"],
          additionalProperties: false,
        },
      },
    },
    required: ["jobs"],
    additionalProperties: false,
  },
  handler: async (args) => {
    try {
      const jobs = (args.jobs as Array<{
        applyLink: string;
        company: string;
        positionTitle: string;
      }>) ?? [];
      if (jobs.length === 1) {
        await markSeen(jobs[0]!);
        return textResult({ marked: 1, cacheSize: await cacheSize() });
      }
      const count = await markSeenBatch(jobs);
      return textResult({ marked: count, cacheSize: await cacheSize() });
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
};

export const cachePruneTool: ToolDefinition = {
  name: "cache_prune",
  description:
    "Delete cached entries older than N days. Useful to keep the local cache from growing unboundedly and to force periodic reconciliation with Airtable. Default: 90 days. ⚡ [Model hint: haiku]",
  recommendedModel: "haiku",
  inputSchema: {
    type: "object",
    properties: {
      days: { type: "number", description: "Cutoff in days. Default 90." },
    },
    additionalProperties: false,
  },
  handler: async (args) => {
    try {
      const days = (args.days as number | undefined) ?? 90;
      const deleted = await pruneOlderThan(days);
      return textResult({ deleted, cacheSize: await cacheSize(), olderThanDays: days });
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
};
