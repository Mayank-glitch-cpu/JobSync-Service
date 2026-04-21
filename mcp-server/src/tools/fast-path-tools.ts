import { loadConfig } from "../config.js";
import { fetchAshby, fetchGreenhouse, fetchLever, fetchWorkday } from "../lib/fast-path.js";
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
    "Fast-path: pull all current postings from Greenhouse boards via the public JSON API (boards-api.greenhouse.io). Slug is the company's board identifier, e.g. 'stripe' for boards.greenhouse.io/stripe. Disabled by default — set config.enableFastPath. ⚡ [Model hint: haiku]",
  recommendedModel: "haiku",
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
    "Fast-path: pull all current postings from Lever boards via api.lever.co/v0/postings. Slug is the company's Lever identifier, e.g. 'netflix' for jobs.lever.co/netflix. Disabled by default — set config.enableFastPath. ⚡ [Model hint: haiku]",
  recommendedModel: "haiku",
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

export const fetchWorkdayTool: ToolDefinition = {
  name: "fetch_workday_jobs",
  description:
    "Fast-path: pull all current postings from a Workday job board via the public CXS API. " +
    "Pass the full board URL, e.g. `https://microsoft.wd1.myworkdayjobs.com/en-US/External` " +
    "or `https://meta.wd5.myworkdayjobs.com/en-US/careers`. " +
    "Workday does not expose exact `datePosted` via this API — dates will be null; use `postedOn` (e.g. 'Posted 3 days ago') from rawFields to gauge recency. " +
    "Disabled by default — set config.enableFastPath. ⚡ [Model hint: haiku]",
  recommendedModel: "haiku",
  inputSchema: {
    type: "object",
    properties: {
      boardUrl: {
        type: "string",
        description: "Full Workday board URL, e.g. https://microsoft.wd1.myworkdayjobs.com/en-US/External",
      },
      boardUrls: {
        type: "array",
        items: { type: "string" },
        description: "Batch of Workday board URLs.",
      },
    },
    additionalProperties: false,
  },
  handler: async (args) => {
    const err = ensureEnabled();
    if (err) return errorResult(err);

    const urls: string[] = Array.isArray(args.boardUrls)
      ? (args.boardUrls as string[]).filter(Boolean)
      : args.boardUrl
      ? [String(args.boardUrl)]
      : [];

    if (urls.length === 0) return errorResult("Provide `boardUrl` or `boardUrls`.");

    try {
      const results = await Promise.all(
        urls.map(async (url) => {
          try {
            const jobs = await fetchWorkday(url);
            return { boardUrl: url, count: jobs.length, jobs };
          } catch (e) {
            return { boardUrl: url, count: 0, error: e instanceof Error ? e.message : String(e) };
          }
        }),
      );
      const total = results.reduce((n, r) => n + r.count, 0);
      return textResult({ total, boards: results.length, results });
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
};

export const fetchAshbyTool: ToolDefinition = {
  name: "fetch_ashby_jobs",
  description:
    "Fast-path: pull all current postings from Ashby boards via api.ashbyhq.com/posting-api/job-board. Slug is the company's Ashby identifier, e.g. 'anthropic' for jobs.ashbyhq.com/anthropic. Disabled by default — set config.enableFastPath. ⚡ [Model hint: haiku]",
  recommendedModel: "haiku",
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
