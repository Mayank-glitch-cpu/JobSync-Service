/**
 * ashby_get_date_posted — extracts the true `datePosted` for an Ashby job by
 * scraping the JSON-LD block embedded in the rendered HTML.
 *
 * Ashby's public posting-api returns `datePosted: null` for every job, but the
 * rendered page at `https://jobs.ashbyhq.com/{slug}/{id}` (or `/application`)
 * embeds a JSON-LD blob like:
 *
 *     "datePosted":"2026-03-26","hiringOrganization":{...}
 *
 * This tool fetches the HTML and pulls the date out so that agents can stamp
 * accurate dates on Ashby jobs and enforce the lookback window.
 */

import { textResult, errorResult, type ToolDefinition } from "./index.js";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const FETCH_TIMEOUT_MS = 15_000;

const DATE_POSTED_RE = /"datePosted"\s*:\s*"([^"]+)"/;

type DateResult = {
  datePosted: string | null;
  statusCode: number | null;
  reason: string;
};

async function fetchWithTimeout(url: string, opts: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeAshbyUrl(input: string): string | null {
  try {
    const u = new URL(input);
    if (!/(^|\.)ashbyhq\.com$/i.test(u.hostname)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

async function extractDatePosted(url: string): Promise<DateResult> {
  try {
    const res = await fetchWithTimeout(url, {
      headers: {
        "user-agent": BROWSER_UA,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.5",
      },
      redirect: "follow",
    });
    if (!res.ok) {
      return {
        datePosted: null,
        statusCode: res.status,
        reason: `HTTP ${res.status} — could not load Ashby page.`,
      };
    }
    const html = await res.text();
    const m = html.match(DATE_POSTED_RE);
    if (!m) {
      return {
        datePosted: null,
        statusCode: res.status,
        reason: 'No "datePosted" field found in page source — JSON-LD may be missing or rendered client-side.',
      };
    }
    return {
      datePosted: m[1]!,
      statusCode: res.status,
      reason: "ok",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("abort") || msg.includes("timeout")) {
      return { datePosted: null, statusCode: null, reason: `Request timed out after ${FETCH_TIMEOUT_MS / 1000}s.` };
    }
    return { datePosted: null, statusCode: null, reason: `Request failed: ${msg}` };
  }
}

export const ashbyGetDatePostedTool: ToolDefinition = {
  name: "ashby_get_date_posted",
  description:
    "Fetches an Ashby job page and extracts the true `datePosted` from its embedded JSON-LD. " +
    "Ashby's public posting-api returns datePosted=null, but the rendered HTML contains " +
    '`"datePosted":"YYYY-MM-DD"` inside a JSON-LD script block. ' +
    "Use this to stamp accurate dates on Ashby jobs before upserting to Airtable, " +
    "or to filter Ashby postings by recency. URL may be the job page or the /application page. ⚡ [Model hint: haiku]",
  recommendedModel: "haiku",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description:
          "Ashby job URL, e.g. https://jobs.ashbyhq.com/{slug}/{postingId} or .../{postingId}/application",
      },
    },
    required: ["url"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const url = String(args.url ?? "").trim();
    if (!url) return errorResult("url is required.");
    const normalized = normalizeAshbyUrl(url);
    if (!normalized) return errorResult(`Not an Ashby URL: ${url}`);
    const result = await extractDatePosted(normalized);
    return textResult({ url: normalized, ...result });
  },
};

export const ashbyGetDatePostedBatchTool: ToolDefinition = {
  name: "ashby_get_date_posted_batch",
  description:
    "Batch version of ashby_get_date_posted. Accepts up to 20 Ashby job URLs and " +
    "scrapes each page's JSON-LD concurrently to resolve `datePosted`. " +
    "Optional `lookbackHours` flags each result with withinLookback=true/false so the " +
    "caller can drop stale postings in a single pass. " +
    "Use this right after `fetch_ashby_jobs` to enrich rows with real posted dates before the lookback filter. ⚡ [Model hint: haiku]",
  recommendedModel: "haiku",
  inputSchema: {
    type: "object",
    properties: {
      urls: {
        type: "array",
        items: { type: "string" },
        description: "List of Ashby job URLs (max 20).",
        maxItems: 20,
      },
      lookbackHours: {
        type: "number",
        description:
          "Optional recency window in hours. When set, each result includes withinLookback (true if datePosted is within the window).",
      },
    },
    required: ["urls"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const urls = (args.urls as string[]) ?? [];
    if (urls.length === 0) return errorResult("urls array is empty.");
    if (urls.length > 20) return errorResult("urls exceeds max batch size of 20.");

    const lookbackHours =
      typeof args.lookbackHours === "number" && Number.isFinite(args.lookbackHours)
        ? args.lookbackHours
        : null;
    const cutoff = lookbackHours !== null ? Date.now() - lookbackHours * 3_600_000 : null;

    const results = await Promise.all(
      urls.map(async (raw) => {
        const url = String(raw ?? "").trim();
        if (!url) {
          return {
            url,
            datePosted: null,
            statusCode: null,
            reason: "Empty URL.",
            withinLookback: null as boolean | null,
          };
        }
        const normalized = normalizeAshbyUrl(url);
        if (!normalized) {
          return {
            url,
            datePosted: null,
            statusCode: null,
            reason: "Not an Ashby URL.",
            withinLookback: null as boolean | null,
          };
        }
        const r = await extractDatePosted(normalized);
        let withinLookback: boolean | null = null;
        if (cutoff !== null && r.datePosted) {
          const t = Date.parse(r.datePosted);
          withinLookback = Number.isNaN(t) ? null : t >= cutoff;
        }
        return { url: normalized, ...r, withinLookback };
      }),
    );

    const found = results.filter((r) => r.datePosted).length;
    const within =
      lookbackHours !== null ? results.filter((r) => r.withinLookback === true).length : null;

    return textResult({
      total: results.length,
      found,
      missing: results.length - found,
      ...(lookbackHours !== null && {
        lookbackHours,
        withinLookback: within,
        outsideLookback: found - (within ?? 0),
      }),
      results,
    });
  },
};
