// Elasticsearch sink — indexes scraped jobs into mutu.dev's `jobs_v2` index via
// the raw ES REST API (the service is open; no SDK needed). Docs are keyed by a
// deterministic id derived from the apply URL so re-indexing upserts in place.
// When embeddings are enabled, each doc gets a 768-dim e5-base-v2 vector matching
// the index's `embedding` (cosine) field for semantic search.

import { loadConfig, type ElasticsearchConfig } from "../config.js";
import { hashUrl } from "./store/local.js";
import { embedPassages, embedQuery } from "./embeddings.js";
import type { ProcessedJob } from "./types.js";

export interface EsDoc {
  id: string;
  title: string;
  company_name: string;
  description: string;
  location: { city: string; state: string; country: string; coordinates: null };
  job_type: string;
  experience_level: string;
  salary: { min_salary: number; max_salary: number; currency: string; period: string } | null;
  required_skills: string[];
  preferred_skills: string[];
  tags: string[];
  industry: string | null;
  job_board: string | null;
  source_url: string | null;
  apply_url: string | null;
  posted_date: string | null;
  remote_allowed: boolean;
  visa_sponsorship: boolean;
  skills_text: string;
  all_text: string;
  embedding?: number[] | null;
}

function esConfig(): ElasticsearchConfig {
  return loadConfig().elasticsearch;
}

function authHeaders(cfg: ElasticsearchConfig): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.apiKey) headers["authorization"] = `ApiKey ${cfg.apiKey}`;
  return headers;
}

/** Deterministic doc id so re-indexing the same posting updates in place. */
export function esDocId(applyLink: string | null): string {
  return `js_${hashUrl(applyLink ?? "")}`;
}

// ── Best-effort parsers for the loosely-typed jobsync fields ──────────────────

/** Split a "City, ST, Country" / "Remote - United States" string into parts. */
function parseLocation(raw: string | null): EsDoc["location"] {
  const fallback = { city: "", state: "", country: "", coordinates: null } as EsDoc["location"];
  if (!raw) return fallback;
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return fallback;
  return {
    city: parts[0] ?? "",
    state: parts.length >= 3 ? parts[1]! : "",
    country: parts[parts.length - 1] ?? "",
    coordinates: null,
  };
}

/** Extract a salary range from strings like "$120k–$160k", "120000-160000 USD/yr". */
function parseSalary(raw: string | null): EsDoc["salary"] {
  if (!raw) return null;
  const nums = Array.from(raw.matchAll(/(\d[\d,]*)\s*([kK])?/g))
    .map((m) => {
      const n = Number(m[1]!.replace(/,/g, ""));
      return m[2] ? n * 1000 : n;
    })
    .filter((n) => Number.isFinite(n) && n >= 1000); // ignore stray small numbers
  if (nums.length === 0) return null;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const currency = /eur|€/i.test(raw) ? "EUR" : /gbp|£/i.test(raw) ? "GBP" : "USD";
  const period = /hour|hr|\/h/i.test(raw) ? "hourly" : "yearly";
  return { min_salary: min, max_salary: max, currency, period };
}

function toIsoDate(d: string | null): string | null {
  if (!d) return null;
  // jobsync stores YYYY-MM-DD; ES `date` accepts it, but normalize to ISO datetime.
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00` : d;
}

/** Map a jobsync ProcessedJob to the `jobs_v2` document shape (no embedding). */
export function toEsDoc(job: ProcessedJob): EsDoc {
  const id = esDocId(job.applyLink);
  const tags = job.tags ?? [];
  const allText = [job.positionTitle, job.company, job.jobDescription ?? "", tags.join(" ")]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return {
    id,
    title: job.positionTitle ?? "",
    company_name: job.company ?? "",
    description: job.jobDescription ?? "",
    location: parseLocation(job.location),
    job_type: job.isInternship ? "internship" : "full_time",
    experience_level: job.isNewGrad ? "entry" : "mid",
    salary: parseSalary(job.salary),
    required_skills: [],
    preferred_skills: [],
    tags,
    industry: job.industry,
    job_board: job.jobBoard,
    source_url: job.applyLink,
    apply_url: job.applyLink,
    posted_date: toIsoDate(job.datePosted),
    remote_allowed: job.workModel === "Remote" || job.workModel === "Hybrid",
    visa_sponsorship: Boolean(job.h1bSponsored),
    skills_text: job.qualifications ?? "",
    all_text: allText,
  };
}

export interface IndexResult {
  indexed: number;
  failed: number;
  errors: Array<{ id: string; error: string }>;
}

/**
 * Index jobs into the configured ES index via the `_bulk` API. Upserts by
 * deterministic id. Embeds with e5-base-v2 when `elasticsearch.embeddings` is on
 * (failures degrade gracefully to docs without an `embedding`).
 */
export async function indexJobs(jobs: ProcessedJob[]): Promise<IndexResult> {
  const cfg = esConfig();
  if (!cfg.url) throw new Error("elasticsearch.url is not configured (set JOBSYNC_ES_URL).");
  if (jobs.length === 0) return { indexed: 0, failed: 0, errors: [] };

  const docs = jobs.map(toEsDoc);

  if (cfg.embeddings) {
    const vectors = await embedPassages(docs.map((d) => d.all_text));
    if (vectors) docs.forEach((d, i) => (d.embedding = vectors[i] ?? null));
  }

  // Bulk body: action line + source line per doc.
  const body =
    docs
      .map((d) => `${JSON.stringify({ index: { _index: cfg.index, _id: d.id } })}\n${JSON.stringify(d)}`)
      .join("\n") + "\n";

  const res = await fetch(`${cfg.url.replace(/\/$/, "")}/_bulk`, {
    method: "POST",
    headers: { ...authHeaders(cfg), "content-type": "application/x-ndjson" },
    body,
  });

  if (!res.ok) {
    throw new Error(`ES _bulk failed: HTTP ${res.status} ${await res.text()}`);
  }

  const json = (await res.json()) as {
    errors: boolean;
    items: Array<{ index?: { _id: string; status: number; error?: { reason: string } } }>;
  };

  const errors: IndexResult["errors"] = [];
  for (const item of json.items) {
    const r = item.index;
    if (r && r.status >= 300) errors.push({ id: r._id, error: r.error?.reason ?? `status ${r.status}` });
  }
  return { indexed: docs.length - errors.length, failed: errors.length, errors };
}

// ── Dedup reconcile + search ──────────────────────────────────────────────────

interface EsHit {
  _id: string;
  _source: Partial<EsDoc>;
}

async function esSearch(cfg: ElasticsearchConfig, query: unknown): Promise<EsHit[]> {
  const res = await fetch(`${cfg.url.replace(/\/$/, "")}/${cfg.index}/_search`, {
    method: "POST",
    headers: authHeaders(cfg),
    body: JSON.stringify(query),
  });
  if (!res.ok) throw new Error(`ES search failed: HTTP ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { hits: { hits: EsHit[] } };
  return json.hits.hits;
}

/** Recent jobs indexed within the last `hours` — the dedup reconcile fallback. */
export async function listRecentEsJobs(hours: number, size = 200): Promise<EsHit["_source"][]> {
  const cfg = esConfig();
  if (!cfg.url) throw new Error("elasticsearch.url is not configured (set JOBSYNC_ES_URL).");
  const hits = await esSearch(cfg, {
    size,
    sort: [{ posted_date: "desc" }],
    query: { range: { posted_date: { gte: `now-${Math.max(1, Math.round(hours))}h` } } },
    _source: ["id", "title", "company_name", "apply_url", "posted_date"],
  });
  return hits.map((h) => h._source);
}

/** Look up a single posting by apply URL (exact match on the keyword subfield). */
export async function findEsJobByUrl(url: string): Promise<EsHit["_source"] | null> {
  const cfg = esConfig();
  if (!cfg.url) throw new Error("elasticsearch.url is not configured (set JOBSYNC_ES_URL).");
  const hits = await esSearch(cfg, {
    size: 1,
    query: { term: { "apply_url.keyword": url } },
  });
  return hits[0]?._source ?? null;
}

export interface SearchOptions {
  size?: number;
  semantic?: boolean;
}

/** Search the index: BM25 over text fields, or kNN over the e5 embedding. */
export async function searchEsJobs(query: string, opts: SearchOptions = {}): Promise<EsHit[]> {
  const cfg = esConfig();
  if (!cfg.url) throw new Error("elasticsearch.url is not configured (set JOBSYNC_ES_URL).");
  const size = opts.size ?? 10;

  if (opts.semantic) {
    const vector = await embedQuery(query);
    if (vector) {
      return esSearch(cfg, {
        knn: { field: "embedding", query_vector: vector, k: size, num_candidates: Math.max(50, size * 5) },
        _source: { excludes: ["embedding"] },
      });
    }
    // Fall through to BM25 if embedding is unavailable.
  }

  return esSearch(cfg, {
    size,
    query: {
      multi_match: {
        query,
        fields: ["title^3", "company_name^2", "description", "all_text", "skills_text", "tags"],
      },
    },
    _source: { excludes: ["embedding"] },
  });
}
