import { loadConfig } from "../config.js";
import { fetchAshby, fetchGreenhouse, fetchLever } from "../lib/fast-path.js";
import { errorResult, textResult, type ToolDefinition } from "./index.js";

function ensureEnabled(): string | null {
  try {
    if (!loadConfig().enableFastPath) {
      return "Fast-path fetchers are disabled. Set `enableFastPath: true` in ~/.jobsync/config.json (or re-run `jobsync-mcp init`) to enable.";
    }
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return null;
}

type Fetcher = (slug: string) => Promise<Array<{ id: string; positionTitle: string }>>;

async function runBatch(fetcher: Fetcher, slugs: string[]) {
  const results = await Promise.all(
    slugs.map(async (slug) => {
      try {
        const jobs = await fetcher(slug);
        return { slug, count: jobs.length, jobs };
      } catch (err) {
        return { slug, count: 0, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
  const total = results.reduce((n, r) => n + r.count, 0);
  return { total, boards: results.length, results };
}

function slugsArg(args: Record<string, unknown>): string[] {
  if (Array.isArray(args.slugs)) return (args.slugs as string[]).filter(Boolean);
  if (args.slug) return [String(args.slug)];
  return [];
}

const slugsSchema = {
  type: "object" as const,
  properties: {
    slug: { type: "string", description: "Single company slug (as it appears in the board URL)." },
    slugs: { type: "array", items: { type: "string" }, description: "Batch of slugs." },
  },
  additionalProperties: false,
};

export const fetchGreenhouseTool: ToolDefinition = {
  name: "fetch_greenhouse_jobs",
  description:
    "Fast-path: pull all current postings from Greenhouse boards via the public JSON API (boards-api.greenhouse.io). Slug is the company's board identifier, e.g. 'stripe' for boards.greenhouse.io/stripe. Disabled by default — set config.enableFastPath.",
  inputSchema: slugsSchema,
  handler: async (args) => {
    const err = ensureEnabled();
    if (err) return errorResult(err);
    const slugs = slugsArg(args);
    if (slugs.length === 0) return errorResult("Provide `slug` or `slugs`.");
    try {
      return textResult(await runBatch(fetchGreenhouse, slugs));
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
};

export const fetchLeverTool: ToolDefinition = {
  name: "fetch_lever_jobs",
  description:
    "Fast-path: pull all current postings from Lever boards via api.lever.co/v0/postings. Slug is the company's Lever identifier, e.g. 'netflix' for jobs.lever.co/netflix. Disabled by default — set config.enableFastPath.",
  inputSchema: slugsSchema,
  handler: async (args) => {
    const err = ensureEnabled();
    if (err) return errorResult(err);
    const slugs = slugsArg(args);
    if (slugs.length === 0) return errorResult("Provide `slug` or `slugs`.");
    try {
      return textResult(await runBatch(fetchLever, slugs));
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
};

export const fetchAshbyTool: ToolDefinition = {
  name: "fetch_ashby_jobs",
  description:
    "Fast-path: pull all current postings from Ashby boards via api.ashbyhq.com/posting-api/job-board. Slug is the company's Ashby identifier, e.g. 'anthropic' for jobs.ashbyhq.com/anthropic. Disabled by default — set config.enableFastPath.",
  inputSchema: slugsSchema,
  handler: async (args) => {
    const err = ensureEnabled();
    if (err) return errorResult(err);
    const slugs = slugsArg(args);
    if (slugs.length === 0) return errorResult("Provide `slug` or `slugs`.");
    try {
      return textResult(await runBatch(fetchAshby, slugs));
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
};
