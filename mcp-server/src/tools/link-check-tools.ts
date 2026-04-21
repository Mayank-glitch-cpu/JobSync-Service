/**
 * verify_job_link — checks whether an apply URL still resolves to a live job posting.
 *
 * Strategy per board:
 *   Greenhouse  → hits boards-api.greenhouse.io/v1/boards/{slug}/jobs/{id} (404 = closed)
 *   Lever       → hits api.lever.co/v0/postings/{slug}/{id} (404 = closed)
 *   Ashby       → hits api.ashbyhq.com/posting-api/job-posting?jobPostingId={id}
 *   Generic     → GET with a browser UA; detects 404/410 or soft-delete phrases in body
 */

import { textResult, errorResult, type ToolDefinition } from "./index.js";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const FETCH_TIMEOUT_MS = 12_000;

/** Phrases in HTML body that indicate a job has been closed/removed. */
const SOFT_CLOSED_PATTERNS = [
  /this (job|position|role|posting) (is no longer|has been) (available|active|open|accepting)/i,
  /job (is|has been) (closed|filled|expired|removed)/i,
  /position (is|has been) (closed|filled|expired|removed)/i,
  /no longer (accepting|taking) applications/i,
  /this (opening|requisition) (is|has been) (closed|filled|expired)/i,
  /sorry.{0,40}(job|position|role).{0,40}(not|no longer) available/i,
  /application period.{0,20}closed/i,
];

type LinkStatus =
  | { active: true; statusCode: number; reason: string }
  | { active: false; statusCode: number | null; reason: string };

// ── Board-specific verifiers ─────────────────────────────────────────────────

/** Extract Greenhouse slug + job-id from a hosted URL. */
function parseGreenhouseUrl(url: string): { slug: string; jobId: string } | null {
  // https://boards.greenhouse.io/{slug}/jobs/{id}
  // https://job-boards.greenhouse.io/{slug}/jobs/{id}
  const m = url.match(/greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/i);
  if (!m) return null;
  return { slug: m[1]!, jobId: m[2]! };
}

/** Extract Lever slug + posting-id from a hosted URL. */
function parseLeverUrl(url: string): { slug: string; postingId: string } | null {
  // https://jobs.lever.co/{slug}/{uuid}
  const m = url.match(/jobs\.lever\.co\/([^/?#]+)\/([0-9a-f-]{36})/i);
  if (!m) return null;
  return { slug: m[1]!, postingId: m[2]! };
}

/** Extract Workday tenant + board + externalPath from a job URL. */
function parseWorkdayUrl(url: string): { apiBase: string; externalPath: string } | null {
  // https://{tenant}.wd{n}.myworkdayjobs.com/en-US/{board}/job/{loc}/{title}_{id}
  const m = url.match(/^(https?:\/\/[^/]+\.myworkdayjobs\.com)\/([^?#]+)/i);
  if (!m) return null;
  const origin = m[1]!;
  const fullPath = m[2]!; // e.g. en-US/External/job/Redmond/Title_JR-123
  // Extract tenant and board from origin hostname
  const hostname = new URL(origin).hostname; // tenant.wd5.myworkdayjobs.com
  const tenant = hostname.split(".")[0]!;
  const pathParts = fullPath.split("/").filter((p) => p && !/^[a-z]{2}(-[A-Z]{2})?$/.test(p));
  const board = pathParts[0] ?? "External";
  return {
    apiBase: `${origin}/wday/cxs/${tenant}/${board}/jobs`,
    externalPath: `/${fullPath}`,
  };
}

/** Extract Ashby posting id from a hosted URL. */
function parseAshbyUrl(url: string): { postingId: string } | null {
  // https://jobs.ashbyhq.com/{slug}/{uuid}
  // https://app.ashbyhq.com/jobs/external/{uuid}
  const m = url.match(/(?:jobs\.ashbyhq\.com\/[^/?#]+|app\.ashbyhq\.com\/jobs\/external)\/([0-9a-f-]{36})/i);
  if (!m) return null;
  return { postingId: m[1]! };
}

async function fetchWithTimeout(url: string, opts: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function checkGreenhouse(slug: string, jobId: string): Promise<LinkStatus> {
  const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(jobId)}`;
  try {
    const res = await fetchWithTimeout(apiUrl, {
      headers: { accept: "application/json" },
    });
    if (res.status === 200) {
      return { active: true, statusCode: 200, reason: "Greenhouse API returned job data (200)." };
    }
    if (res.status === 404) {
      return { active: false, statusCode: 404, reason: "Greenhouse API returned 404 — job is closed or removed." };
    }
    return { active: false, statusCode: res.status, reason: `Greenhouse API returned unexpected status ${res.status}.` };
  } catch (err) {
    return { active: false, statusCode: null, reason: `Request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function checkLever(slug: string, postingId: string): Promise<LinkStatus> {
  const apiUrl = `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}/${encodeURIComponent(postingId)}`;
  try {
    const res = await fetchWithTimeout(apiUrl, {
      headers: { accept: "application/json" },
    });
    if (res.status === 200) {
      const body = (await res.json()) as Record<string, unknown>;
      // Lever returns { state: "published" | "closed" | ... }
      if (typeof body.state === "string" && body.state !== "published") {
        return { active: false, statusCode: 200, reason: `Lever posting state is "${body.state}" (not published).` };
      }
      return { active: true, statusCode: 200, reason: "Lever API returned published posting (200)." };
    }
    if (res.status === 404) {
      return { active: false, statusCode: 404, reason: "Lever API returned 404 — posting is gone." };
    }
    return { active: false, statusCode: res.status, reason: `Lever API returned unexpected status ${res.status}.` };
  } catch (err) {
    return { active: false, statusCode: null, reason: `Request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function checkWorkday(apiBase: string, externalPath: string): Promise<LinkStatus> {
  // Workday has no single-job lookup endpoint — search with the externalPath as a hint.
  // If the job is gone the path simply won't appear in results; fall back to a GET check.
  try {
    const res = await fetchWithTimeout(apiBase.replace(/\/jobs$/, "") + externalPath, {
      headers: { "user-agent": BROWSER_UA, accept: "text/html,*/*" },
      redirect: "follow",
    });
    if (res.status === 404 || res.status === 410) {
      return { active: false, statusCode: res.status, reason: `Workday job page returned ${res.status} — posting is gone.` };
    }
    if (res.status >= 500) {
      return { active: false, statusCode: res.status, reason: `Workday server error ${res.status} — could not confirm posting is live.` };
    }
    // Scan body for soft-close language
    const contentType = res.headers.get("content-type") ?? "";
    if (res.status === 200 && (contentType.includes("text/html") || contentType.includes("text/plain"))) {
      const reader = res.body?.getReader();
      if (reader) {
        let text = "";
        const decoder = new TextDecoder();
        let totalBytes = 0;
        while (totalBytes < 32_768) {
          const { done, value } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
          totalBytes += value.byteLength;
        }
        reader.cancel().catch(() => undefined);
        // Workday-specific closed indicators
        const workdayClosed = /this job is no longer available|job has been filled|no longer accepting|position has been filled/i;
        if (workdayClosed.test(text)) {
          return { active: false, statusCode: 200, reason: "Workday page loaded but contains closed-job language." };
        }
      }
    }
    return { active: true, statusCode: res.status, reason: `Workday job page returned ${res.status} — no closure indicators detected.` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("abort") || msg.includes("timeout")) {
      return { active: false, statusCode: null, reason: `Request timed out after ${FETCH_TIMEOUT_MS / 1000}s.` };
    }
    return { active: false, statusCode: null, reason: `Request failed: ${msg}` };
  }
}

async function checkAshby(postingId: string): Promise<LinkStatus> {
  const apiUrl = `https://api.ashbyhq.com/posting-api/job-posting?jobPostingId=${encodeURIComponent(postingId)}`;
  try {
    const res = await fetchWithTimeout(apiUrl, {
      headers: { accept: "application/json" },
    });
    if (res.status === 200) {
      const body = (await res.json()) as Record<string, unknown>;
      // Ashby wraps: { success: boolean, job: { isListed: boolean, ... } }
      if (body.success === false) {
        return { active: false, statusCode: 200, reason: "Ashby API responded but success=false — posting not found." };
      }
      const job = body.job as Record<string, unknown> | undefined;
      if (job && job.isListed === false) {
        return { active: false, statusCode: 200, reason: "Ashby posting exists but isListed=false (unlisted/closed)." };
      }
      return { active: true, statusCode: 200, reason: "Ashby API returned a live posting." };
    }
    if (res.status === 404) {
      return { active: false, statusCode: 404, reason: "Ashby API returned 404 — posting is closed or removed." };
    }
    return { active: false, statusCode: res.status, reason: `Ashby API returned unexpected status ${res.status}.` };
  } catch (err) {
    return { active: false, statusCode: null, reason: `Request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function checkGeneric(url: string): Promise<LinkStatus> {
  try {
    const res = await fetchWithTimeout(url, {
      method: "GET",
      headers: {
        "user-agent": BROWSER_UA,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.5",
      },
      redirect: "follow",
    });

    if (res.status === 404 || res.status === 410) {
      return { active: false, statusCode: res.status, reason: `HTTP ${res.status} — job page not found or gone.` };
    }

    if (res.status >= 500) {
      return { active: false, statusCode: res.status, reason: `Server error ${res.status} — could not confirm posting is live.` };
    }

    if (res.status >= 300) {
      // Unusual redirect not followed (non-2xx after redirect chain)
      return { active: false, statusCode: res.status, reason: `Unexpected redirect/status ${res.status}.` };
    }

    // 200: scan a portion of the body for soft-close language
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("text/html") || contentType.includes("text/plain")) {
      // Read up to 32 KB to keep memory bounded
      const reader = res.body?.getReader();
      if (reader) {
        let text = "";
        const decoder = new TextDecoder();
        let totalBytes = 0;
        while (totalBytes < 32_768) {
          const { done, value } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
          totalBytes += value.byteLength;
        }
        reader.cancel().catch(() => undefined);

        for (const pattern of SOFT_CLOSED_PATTERNS) {
          if (pattern.test(text)) {
            return {
              active: false,
              statusCode: res.status,
              reason: `Page loaded (${res.status}) but contains closed-job language matching: ${pattern.source}`,
            };
          }
        }
      }
    }

    return { active: true, statusCode: res.status, reason: `HTTP ${res.status} — no closure indicators detected.` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("abort") || msg.includes("timeout")) {
      return { active: false, statusCode: null, reason: `Request timed out after ${FETCH_TIMEOUT_MS / 1000}s.` };
    }
    return { active: false, statusCode: null, reason: `Request failed: ${msg}` };
  }
}

// ── Tool definitions ─────────────────────────────────────────────────────────

export const verifyJobLinkTool: ToolDefinition = {
  name: "verify_job_link",
  description:
    "Checks whether an apply URL still resolves to a live, open job posting. " +
    "For Greenhouse, Lever, and Ashby it uses the public posting API for a reliable status check. " +
    "For other URLs it does a GET with a browser User-Agent and scans the response for closure language. " +
    "Returns { active, statusCode, reason }. Use this before upserting to Airtable to avoid syncing dead links. ⚡ [Model hint: haiku]",
  recommendedModel: "haiku",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The apply/job link to verify (applyLink field).",
      },
    },
    required: ["url"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const url = String(args.url ?? "").trim();
    if (!url) return errorResult("url is required.");

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return errorResult(`Invalid URL: ${url}`);
    }

    let result: LinkStatus;

    // Board-specific fast paths
    const gh = parseGreenhouseUrl(url);
    if (gh) {
      result = await checkGreenhouse(gh.slug, gh.jobId);
    } else {
      const lever = parseLeverUrl(url);
      if (lever) {
        result = await checkLever(lever.slug, lever.postingId);
      } else {
        const ashby = parseAshbyUrl(url);
        if (ashby) {
          result = await checkAshby(ashby.postingId);
        } else {
          const workday = parseWorkdayUrl(url);
          if (workday) {
            result = await checkWorkday(workday.apiBase, workday.externalPath);
          } else {
            result = await checkGeneric(url);
          }
        }
      }
    }

    return textResult({ url, ...result });
  },
};

export const verifyJobLinkBatchTool: ToolDefinition = {
  name: "verify_job_link_batch",
  description:
    "Batch version of verify_job_link. Accepts up to 20 URLs and checks each concurrently. " +
    "Returns an array of { url, active, statusCode, reason } objects plus summary counts. " +
    "Use this to bulk-validate a page of job postings before upserting to Airtable. ⚡ [Model hint: haiku]",
  recommendedModel: "haiku",
  inputSchema: {
    type: "object",
    properties: {
      urls: {
        type: "array",
        items: { type: "string" },
        description: "List of apply URLs to verify (max 20).",
        maxItems: 20,
      },
    },
    required: ["urls"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const urls = (args.urls as string[]) ?? [];
    if (urls.length === 0) return errorResult("urls array is empty.");
    if (urls.length > 20) return errorResult("urls exceeds max batch size of 20.");

    // Reuse the single-URL handler logic inline to avoid circular dependency
    const checks = await Promise.all(
      urls.map(async (rawUrl) => {
        const url = String(rawUrl ?? "").trim();
        if (!url) return { url, active: false, statusCode: null, reason: "Empty URL." };

        try {
          new URL(url);
        } catch {
          return { url, active: false, statusCode: null, reason: "Invalid URL." };
        }

        let result: LinkStatus;
        const gh = parseGreenhouseUrl(url);
        if (gh) {
          result = await checkGreenhouse(gh.slug, gh.jobId);
        } else {
          const lever = parseLeverUrl(url);
          if (lever) {
            result = await checkLever(lever.slug, lever.postingId);
          } else {
            const ashby = parseAshbyUrl(url);
            if (ashby) {
              result = await checkAshby(ashby.postingId);
            } else {
              const workday = parseWorkdayUrl(url);
              if (workday) {
                result = await checkWorkday(workday.apiBase, workday.externalPath);
              } else {
                result = await checkGeneric(url);
              }
            }
          }
        }
        return { url, ...result };
      }),
    );

    const active = checks.filter((c) => c.active).length;
    return textResult({
      total: checks.length,
      active,
      inactive: checks.length - active,
      results: checks,
    });
  },
};
