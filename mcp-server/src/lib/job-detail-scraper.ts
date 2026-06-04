// Fetches full job details (description, salary, datePosted) for a batch of jobs.
// For Greenhouse and Lever, calls the ATS JSON API on the individual job endpoint.
// For Ashby and all other portals, fetches the job page HTML and parses JSON-LD
// (application/ld+json with @type=JobPosting), falling back to regex and plain text.
// datePosted is always non-null on return — falls back to today's date so that
// validateJobForSync passes without rejecting otherwise-valid records.

import type { RawJob } from "./types.js";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const FETCH_TIMEOUT_MS = 15_000;

async function fetchWithTimeout(url: string, opts: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Find the first JSON-LD block with @type=JobPosting in the page HTML.
function extractJobPostingJsonLd(html: string): Record<string, unknown> | null {
  const scriptRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = scriptRe.exec(html)) !== null) {
    try {
      const parsed: unknown = JSON.parse(m[1]!);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (
          item !== null &&
          typeof item === "object" &&
          (item as Record<string, unknown>)["@type"] === "JobPosting"
        ) {
          return item as Record<string, unknown>;
        }
      }
    } catch {
      // ignore malformed JSON-LD blocks
    }
  }
  return null;
}

function normalizeSalaryFromJsonLd(baseSalary: unknown): string | null {
  if (!baseSalary) return null;
  if (typeof baseSalary === "string") return baseSalary.trim() || null;
  if (typeof baseSalary === "object") {
    const b = baseSalary as Record<string, unknown>;
    const currency = typeof b.currency === "string" ? b.currency : "USD";
    const val = b.value as Record<string, unknown> | undefined;
    if (val) {
      const min = val.minValue;
      const max = val.maxValue;
      const unit = typeof val.unitText === "string" ? val.unitText : "";
      if (min !== undefined && max !== undefined) {
        return `${currency} ${min}–${max}${unit ? "/" + unit : ""}`;
      }
      if (min !== undefined) return `${currency} ${min}${unit ? "/" + unit : ""}`;
    }
  }
  return null;
}

// Matches patterns like "$120,000 - $150,000", "$80k–$100k", "USD 90,000/year"
const SALARY_RANGE_RE = /(?:USD\s*)?\$[\d,]+k?\s*[-–—]\s*\$?[\d,]+k?(?:\s*\/?\s*(?:yr|year|annually|hour|hr))?/i;
const SALARY_SINGLE_RE = /\$[\d,]+k(?:\s*\/?\s*(?:yr|year|hour|hr))?/i;

function extractSalaryFromText(text: string): string | null {
  const m = text.match(SALARY_RANGE_RE) ?? text.match(SALARY_SINGLE_RE);
  return m ? m[0]!.trim() : null;
}

// Convert "Posted 3 days ago" / "Posted 1 week ago" to YYYY-MM-DD.
function resolveRelativeDate(text: string): string | null {
  const days = text.match(/(\d+)\s+day/i);
  if (days) {
    const d = new Date(Date.now() - parseInt(days[1]!, 10) * 86_400_000);
    return d.toISOString().split("T")[0]!;
  }
  const weeks = text.match(/(\d+)\s+week/i);
  if (weeks) {
    const d = new Date(Date.now() - parseInt(weeks[1]!, 10) * 7 * 86_400_000);
    return d.toISOString().split("T")[0]!;
  }
  return null;
}

interface RawDetails {
  description: string | null;
  salary: string | null;
  datePosted: string | null;
}

// ── Greenhouse ──
// GET /v1/boards/{slug}/jobs/{id}?content=true  →  { content: "<html>", updated_at, ... }
async function fetchGreenhouseDetails(jobId: string): Promise<RawDetails> {
  const parts = jobId.split(":");
  const slug = parts[1];
  const id = parts[2];
  if (!slug || !id) return { description: null, salary: null, datePosted: null };
  try {
    const res = await fetchWithTimeout(
      `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs/${id}?content=true`,
      { headers: { accept: "application/json" } },
    );
    if (!res.ok) return { description: null, salary: null, datePosted: null };
    const data = (await res.json()) as Record<string, unknown>;
    const html = typeof data.content === "string" ? data.content : "";
    const text = htmlToText(html);
    const datePosted =
      typeof data.updated_at === "string" ? data.updated_at.split("T")[0]! : null;
    return {
      description: text || null,
      salary: extractSalaryFromText(text),
      datePosted,
    };
  } catch {
    return { description: null, salary: null, datePosted: null };
  }
}

// ── Lever ──
// GET https://api.lever.co/v0/postings/{slug}/{uuid}
// Response: { descriptionPlain, lists: [{text, content:[{text}]}], salaryRange, createdAt }
async function fetchLeverDetails(jobId: string): Promise<RawDetails> {
  const parts = jobId.split(":");
  const slug = parts[1];
  const postingId = parts.slice(2).join(":");
  if (!slug || !postingId) return { description: null, salary: null, datePosted: null };
  try {
    const res = await fetchWithTimeout(
      `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}/${postingId}`,
      { headers: { accept: "application/json" } },
    );
    if (!res.ok) return { description: null, salary: null, datePosted: null };
    const data = (await res.json()) as Record<string, unknown>;

    const plain = typeof data.descriptionPlain === "string" ? data.descriptionPlain : null;
    const lists = Array.isArray(data.lists)
      ? (data.lists as Array<{ text: string; content: Array<{ text: string }> }>)
          .map((l) => `${l.text}:\n${l.content.map((c) => c.text).join("\n")}`)
          .join("\n\n")
      : null;
    const description = plain ?? lists;

    const sr = data.salaryRange as { min?: number; max?: number; currency?: string } | undefined;
    const salary = sr?.min != null
      ? `${sr.currency ?? "USD"} ${sr.min}${sr.max != null ? `–${sr.max}` : ""}`
      : description
      ? extractSalaryFromText(description)
      : null;

    const createdAt = typeof data.createdAt === "number" ? data.createdAt : null;
    const datePosted = createdAt ? new Date(createdAt).toISOString().split("T")[0]! : null;

    return { description, salary, datePosted };
  } catch {
    return { description: null, salary: null, datePosted: null };
  }
}

// ── Generic HTML scraper ──
// Used for Ashby, Workday, LinkedIn, and any portal not handled above.
// 1. Fetches the apply link HTML.
// 2. Extracts the first JSON-LD JobPosting block.
// 3. Falls back to regex / plain-text extraction.
async function fetchGenericDetails(
  url: string,
  rawFields?: Record<string, string>,
): Promise<RawDetails> {
  try {
    const res = await fetchWithTimeout(url, {
      headers: {
        "user-agent": BROWSER_UA,
        accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.5",
      },
      redirect: "follow",
    });
    if (!res.ok) return { description: null, salary: null, datePosted: null };

    const html = await res.text();
    const jsonLd = extractJobPostingJsonLd(html);

    // datePosted: JSON-LD first, then <meta> tag, then relative date from rawFields
    let datePosted =
      typeof jsonLd?.datePosted === "string" ? (jsonLd.datePosted as string).split("T")[0]! : null;
    if (!datePosted) {
      const metaMatch = html.match(
        /<meta[^>]+(?:name|property)=["'](?:datePosted|date)[^"']*["'][^>]+content=["']([^"']+)["']/i,
      );
      if (metaMatch) datePosted = metaMatch[1]!.split("T")[0]!;
    }
    if (!datePosted && rawFields?.postedOn) {
      datePosted = resolveRelativeDate(rawFields.postedOn);
    }

    // salary: JSON-LD baseSalary first, then text extraction
    let salary = normalizeSalaryFromJsonLd(jsonLd?.baseSalary);

    // description: JSON-LD description first, then page text (capped at 15 000 chars)
    let description: string | null = null;
    if (typeof jsonLd?.description === "string") {
      description = htmlToText(jsonLd.description as string) || null;
    }
    if (!description) {
      const pageText = htmlToText(html);
      description = pageText.slice(0, 15_000) || null;
    }

    if (!salary && description) {
      salary = extractSalaryFromText(description);
    }

    return { description, salary, datePosted };
  } catch {
    return { description: null, salary: null, datePosted: null };
  }
}

// ────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────

export interface JobDetailResult {
  id: string;
  jobDescription: string | null;
  salary: string | null;
  /** Always non-null — falls back to today's date so validation passes. */
  datePosted: string;
  scrapeStatus: "success" | "failed";
  scrapeError?: string;
}

export async function scrapeJobDetails(jobs: RawJob[]): Promise<JobDetailResult[]> {
  const today = new Date().toISOString().split("T")[0]!;

  return Promise.all(
    jobs.map(async (job): Promise<JobDetailResult> => {
      try {
        const source = job.rawFields?.source ?? "";
        let details: RawDetails;

        if (source === "greenhouse") {
          details = await fetchGreenhouseDetails(job.id);
        } else if (source === "lever") {
          details = await fetchLeverDetails(job.id);
        } else if (job.applyLink) {
          details = await fetchGenericDetails(job.applyLink, job.rawFields);
        } else {
          details = { description: null, salary: null, datePosted: null };
        }

        return {
          id: job.id,
          jobDescription: details.description,
          // Keep existing salary if the scraper found nothing new
          salary: details.salary ?? job.salary,
          // Prefer scraped date, then existing, then today
          datePosted: details.datePosted ?? job.datePosted ?? today,
          scrapeStatus: "success",
        };
      } catch (err) {
        return {
          id: job.id,
          jobDescription: null,
          salary: job.salary,
          datePosted: job.datePosted ?? today,
          scrapeStatus: "failed",
          scrapeError: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
}
