// Minimal direct-JSON fetchers for the public ATS job-board APIs.
// Gated by config.enableFastPath — default off because the agentic path
// via web_search + web_fetch is the intended model. These exist for users
// who want deterministic, high-volume pulls from a known company list.
//
// Each function returns RawJob[]. The agent still drives classification,
// dedup, and upsert via the other MCP tools.

import type { RawJob } from "./types.js";

const FETCH_HEADERS = {
  "user-agent": "jobsync-mcp/0.1 (+https://github.com/anthropic/jobsync-service)",
  accept: "application/json",
};

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: FETCH_HEADERS });
  if (!res.ok) {
    throw new Error(`${url} → ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

// ---------- Greenhouse ----------
// https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true

interface GreenhouseJob {
  id: number;
  title: string;
  absolute_url: string;
  updated_at: string;
  location: { name: string } | null;
  company_name?: string;
  offices?: Array<{ name: string }>;
}

export async function fetchGreenhouse(slug: string): Promise<RawJob[]> {
  const data = await getJson<{ jobs: GreenhouseJob[] }>(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs`,
  );
  const company = data.jobs[0]?.company_name ?? slug;
  return data.jobs.map((j) => ({
    id: `gh:${slug}:${j.id}`,
    positionTitle: j.title,
    company,
    location: j.location?.name ?? j.offices?.[0]?.name ?? null,
    applyLink: j.absolute_url,
    datePosted: j.updated_at ?? null,
    salary: null,
    rawFields: { source: "greenhouse", slug },
  }));
}

// ---------- Lever ----------
// https://api.lever.co/v0/postings/{slug}?mode=json

interface LeverJob {
  id: string;
  text: string;
  hostedUrl: string;
  createdAt: number;
  categories?: { location?: string; team?: string; commitment?: string };
  salaryRange?: { min: number; max: number; currency: string };
}

export async function fetchLever(slug: string): Promise<RawJob[]> {
  const data = await getJson<LeverJob[]>(
    `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`,
  );
  return data.map((j) => ({
    id: `lever:${slug}:${j.id}`,
    positionTitle: j.text,
    company: slug,
    location: j.categories?.location ?? null,
    applyLink: j.hostedUrl,
    datePosted: j.createdAt ? new Date(j.createdAt).toISOString() : null,
    salary: j.salaryRange
      ? `${j.salaryRange.min}-${j.salaryRange.max} ${j.salaryRange.currency}`
      : null,
    rawFields: { source: "lever", slug, team: j.categories?.team ?? "" },
  }));
}

// ---------- Ashby ----------
// https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true

interface AshbyJob {
  id: string;
  title: string;
  jobUrl: string;
  publishedDate?: string;
  locationName?: string;
  teamName?: string;
  employmentType?: string;
  compensationTierSummary?: string;
}

export async function fetchAshby(slug: string): Promise<RawJob[]> {
  const data = await getJson<{ jobs: AshbyJob[] }>(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`,
  );
  return (data.jobs ?? []).map((j) => ({
    id: `ashby:${slug}:${j.id}`,
    positionTitle: j.title,
    company: slug,
    location: j.locationName ?? null,
    applyLink: j.jobUrl,
    datePosted: j.publishedDate ?? null,
    salary: j.compensationTierSummary ?? null,
    rawFields: {
      source: "ashby",
      slug,
      team: j.teamName ?? "",
      employmentType: j.employmentType ?? "",
    },
  }));
}

// ---------- Workday ----------
// POST https://{tenant}.wd{n}.myworkdayjobs.com/wday/cxs/{tenant}/{board}/jobs
// Body: { "limit": 20, "offset": 0, "searchText": "" }
// Response: { "jobPostings": [...], "total": N }

interface WorkdayPosting {
  title: string;
  externalPath: string;
  locationsText?: string;
  postedOn?: string;
  jobReqId?: string;
  jobFamilyGroup?: string;
}

function parseWorkdayUrl(boardUrl: string): { origin: string; tenant: string; board: string } {
  const u = new URL(boardUrl.startsWith("http") ? boardUrl : `https://${boardUrl}`);
  const tenant = u.hostname.split(".")[0] ?? "unknown";
  // Path is typically /en-US/{board} — take the first non-locale segment
  const board = u.pathname.split("/").filter((p) => p && !/^[a-z]{2}(-[A-Z]{2})?$/.test(p))[0] ?? "External";
  return { origin: `${u.protocol}//${u.hostname}`, tenant, board };
}

export async function fetchWorkday(boardUrl: string): Promise<RawJob[]> {
  const { origin, tenant, board } = parseWorkdayUrl(boardUrl);
  const apiUrl = `${origin}/wday/cxs/${tenant}/${board}/jobs`;

  const allJobs: RawJob[] = [];
  let offset = 0;
  const limit = 20;
  const MAX_JOBS = 200;

  while (allJobs.length < MAX_JOBS) {
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": FETCH_HEADERS["user-agent"],
      },
      body: JSON.stringify({ limit, offset, searchText: "" }),
    });
    if (!res.ok) throw new Error(`Workday API ${apiUrl} → ${res.status} ${res.statusText}`);

    const data = (await res.json()) as { jobPostings: WorkdayPosting[]; total: number };
    const postings = data.jobPostings ?? [];
    if (postings.length === 0) break;

    for (const p of postings) {
      allJobs.push({
        id: `workday:${tenant}:${p.jobReqId ?? p.externalPath}`,
        positionTitle: p.title,
        company: tenant,
        location: p.locationsText ?? null,
        applyLink: `${origin}${p.externalPath}`,
        datePosted: null,
        salary: null,
        rawFields: {
          source: "workday",
          tenant,
          board,
          postedOn: p.postedOn ?? "",
          jobFamily: p.jobFamilyGroup ?? "",
        },
      });
    }

    offset += postings.length;
    if (offset >= data.total) break;
  }

  return allJobs;
}
