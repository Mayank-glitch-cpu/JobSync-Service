import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../logger.js';
import { writeStep } from '../store.js';
import type { RawJob } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SLUGS_PATH = path.join(__dirname, '../../data/workday-slugs.json');

// ─── Workday Internal JSON API ──────────────────────────────────────────
// Each company's Workday careers site exposes a JSON endpoint:
//   POST https://{tenant}.wd{instance}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
//
// Request body: { "appliedFacets": {}, "limit": 20, "offset": 0, "searchText": "..." }
// No authentication required — this is the same API their frontend JS calls.

// ─── Types ──────────────────────────────────────────────────────────────

interface WorkdaySlugEntry {
  /** e.g. "amazon" */
  tenant: string;
  /** e.g. 5 (for wd5.myworkdayjobs.com) */
  instance: number;
  /** e.g. "AmazonNew" — the career site name in the URL path */
  site: string;
  /** Display name */
  name: string;
}

interface WorkdayJobPosting {
  bulletFields: string[];
  descriptionPlain?: string;
  title: string;
  locationsText?: string;
  postedOn?: string;          // "Posted 2 Days Ago" or date string
  externalPath?: string;      // "/en-US/jobs/details/12345"
  timeType?: string;          // "Full time"
  jobReqId?: string;
  subtitles?: Array<{ instances: Array<{ text: string }> }>;
}

interface WorkdaySearchResponse {
  total: number;
  jobPostings: WorkdayJobPosting[];
}

interface WorkdayJobDetail {
  jobPostingInfo?: {
    title?: string;
    location?: string;
    timeType?: string;
    postedOn?: string;
    startDate?: string;
    jobReqId?: string;
    jobDescription?: string;
    additionalLocations?: string[];
    videoURL?: string;
  };
}

// ─── Default Workday Tenants ────────────────────────────────────────────
// These are known, verified Workday career sites for major H1B sponsors.
// Format: tenant.wd{instance}.myworkdayjobs.com/{site}

const DEFAULT_SLUGS: WorkdaySlugEntry[] = [
  { tenant: 'amazon', instance: 5, site: 'AmazonNew', name: 'Amazon' },
  { tenant: 'capitalone', instance: 5, site: 'Capital_One', name: 'Capital One' },
  { tenant: 'salesforce', instance: 5, site: 'Careers', name: 'Salesforce' },
  { tenant: 'servicenow', instance: 5, site: 'Careers', name: 'ServiceNow' },
  { tenant: 'eblocker', instance: 5, site: 'Netflix', name: 'Netflix' },
  { tenant: 'uberent', instance: 5, site: 'Uber', name: 'Uber' },
  { tenant: 'palantir', instance: 5, site: 'palantir', name: 'Palantir' },
  { tenant: 'block', instance: 5, site: 'Block', name: 'Block' },
  { tenant: 'paypal', instance: 5, site: 'Jobs', name: 'PayPal' },
  { tenant: 'qualcomm', instance: 5, site: 'External', name: 'Qualcomm' },
  { tenant: 'JPMC', instance: 5, site: 'careers', name: 'JPMorgan Chase' },
  { tenant: 'GoldmanSachs', instance: 2, site: 'gs-careers', name: 'Goldman Sachs' },
  { tenant: 'MorganStanley', instance: 5, site: 'morganstanley', name: 'Morgan Stanley' },
  { tenant: 'citizensbank', instance: 5, site: 'Careers', name: 'Citizens Bank' },
  { tenant: 'wd1nvidia', instance: 5, site: 'NVIDIAExternalCareerSite', name: 'NVIDIA' },
  { tenant: 'adobe', instance: 5, site: 'external_experienced', name: 'Adobe' },
  { tenant: 'zillow', instance: 5, site: 'Zillow_Group', name: 'Zillow' },
  { tenant: 'crowdstrike', instance: 5, site: 'crowdstrikecareers', name: 'CrowdStrike' },
  { tenant: 'lockheedmartin', instance: 5, site: 'LMCAREERSJOBS', name: 'Lockheed Martin' },
  { tenant: 'raytheon', instance: 1, site: 'RTN', name: 'RTX/Raytheon' },
  { tenant: 'generalelectric', instance: 5, site: 'GE_Careers', name: 'GE Aerospace' },
  { tenant: 'Honeywell', instance: 5, site: 'Honeywell', name: 'Honeywell' },
  { tenant: 'target', instance: 5, site: 'targetcareers', name: 'Target' },
  { tenant: 'homedepot', instance: 5, site: 'CareerDepot', name: 'Home Depot' },
  { tenant: 'nike', instance: 1, site: 'NikeInc', name: 'Nike' },
  { tenant: 'starbucks', instance: 5, site: 'Starbucks', name: 'Starbucks' },
  { tenant: 'ford', instance: 5, site: 'FordCareers', name: 'Ford' },
  { tenant: 'gm', instance: 5, site: 'Careers_Opportunities', name: 'General Motors' },
  { tenant: 'elililly', instance: 5, site: 'LillyCareers', name: 'Eli Lilly' },
  { tenant: 'abbvie', instance: 5, site: 'abbvie', name: 'AbbVie' },
  { tenant: 'thermofisher', instance: 5, site: 'Careers', name: 'Thermo Fisher' },
];

function loadSlugs(): WorkdaySlugEntry[] {
  try {
    const raw = fs.readFileSync(SLUGS_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return DEFAULT_SLUGS;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function buildBaseUrl(entry: WorkdaySlugEntry): string {
  return `https://${entry.tenant}.wd${entry.instance}.myworkdayjobs.com`;
}

function buildApiUrl(entry: WorkdaySlugEntry): string {
  return `${buildBaseUrl(entry)}/wday/cxs/${entry.tenant}/${entry.site}/jobs`;
}

function buildJobUrl(entry: WorkdaySlugEntry, externalPath: string): string {
  return `${buildBaseUrl(entry)}/en-US/${entry.site}${externalPath}`;
}

/**
 * Parse relative dates like "Posted 2 Days Ago", "Posted 30+ Days Ago",
 * "Posted Today", "Posted Yesterday" into ISO date strings.
 */
function parsePostedOn(postedOn: string | undefined): string | null {
  if (!postedOn) return null;

  const text = postedOn.toLowerCase().trim();
  const now = new Date();

  if (text.includes('today') || text.includes('0 day')) {
    return now.toISOString().split('T')[0];
  }
  if (text.includes('yesterday') || text.includes('1 day')) {
    now.setDate(now.getDate() - 1);
    return now.toISOString().split('T')[0];
  }

  const daysMatch = text.match(/(\d+)\s*day/);
  if (daysMatch) {
    const days = parseInt(daysMatch[1], 10);
    now.setDate(now.getDate() - days);
    return now.toISOString().split('T')[0];
  }

  // Try parsing as a date directly
  const parsed = new Date(postedOn);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().split('T')[0];
  }

  return null;
}

// ─── Workday API Calls ──────────────────────────────────────────────────

async function searchWorkdayJobs(
  entry: WorkdaySlugEntry,
  searchText: string,
  limit: number,
  offset: number = 0,
  facets: Record<string, string[]> = {}
): Promise<WorkdaySearchResponse | null> {
  const url = buildApiUrl(entry);

  const body = JSON.stringify({
    appliedFacets: facets,
    limit,
    offset,
    searchText,
  });

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      },
      body,
    });

    if (!response.ok) {
      log('fetch', 'warn', `    Workday API returned ${response.status} for ${entry.name}`);
      return null;
    }

    return await response.json();
  } catch (err) {
    log('fetch', 'error', `    Workday error for ${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function fetchJobDetail(
  entry: WorkdaySlugEntry,
  externalPath: string
): Promise<WorkdayJobDetail | null> {
  const url = `${buildBaseUrl(entry)}/wday/cxs/${entry.tenant}/${entry.site}${externalPath}`;

  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      },
    });

    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

// ─── Main Export ────────────────────────────────────────────────────────

export interface FetchWorkdayOptions {
  range?: { from: number; to: number };
  limit?: number;
  /** Search queries to run on each company. Default: ['software engineer']. */
  queries?: string[];
  /** Pick specific tenants. Uses all from slugs file if empty. */
  tenants?: string[];
  /** Max results per company per query. Default: 10. */
  perCompanyLimit?: number;
  /** Fetch individual job details for description. Default: false (slower). */
  fetchDetails?: boolean;
  /** Only keep postings from the last N days. Default: 7. */
  maxAgeDays?: number;
}

export async function fetchWorkday(options: FetchWorkdayOptions = {}): Promise<number> {
  const allSlugs = loadSlugs();
  const selectedSlugs = options.tenants?.length
    ? allSlugs.filter((s) =>
        options.tenants!.some((t) => t.toLowerCase() === s.tenant.toLowerCase())
      )
    : allSlugs;

  const queries = options.queries ?? ['software engineer', 'robotics engineer', 'UI UX developer', 'AI ML engineer'];
  const perCompanyLimit = options.perCompanyLimit ?? 10;
  const fetchDetailsBool = options.fetchDetails ?? false;
  const maxAgeDays = options.maxAgeDays ?? 7;

  log('fetch', 'info', `Fetching Workday jobs for ${selectedSlugs.length} companies...`);
  log('fetch', 'info', `  Queries: ${queries.join(' | ')}, limit/company: ${perCompanyLimit}`);

  interface CollectedJob {
    entry: WorkdaySlugEntry;
    posting: WorkdayJobPosting;
    detail?: WorkdayJobDetail | null;
    query: string;
  }

  const collected: CollectedJob[] = [];
  const seenPaths = new Set<string>();

  for (const entry of selectedSlugs) {
    log('fetch', 'info', `\n  ▸ ${entry.name} (${entry.tenant}.wd${entry.instance}/${entry.site})`);

    for (const query of queries) {
      const result = await searchWorkdayJobs(entry, query, perCompanyLimit);

      if (!result) {
        log('fetch', 'warn', `    ${entry.name} — query "${query}" failed`);
        continue;
      }

      log('fetch', 'info', `    "${query}": ${result.jobPostings?.length || 0} results (total: ${result.total})`);

      for (const posting of result.jobPostings || []) {
        // Deduplicate by externalPath
        const key = `${entry.tenant}:${posting.externalPath}`;
        if (seenPaths.has(key)) continue;
        seenPaths.add(key);

        // Date filter
        const dateStr = parsePostedOn(posting.postedOn);
        if (dateStr && maxAgeDays > 0) {
          const postDate = new Date(dateStr);
          const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
          if (postDate < cutoff) continue;
        }

        collected.push({ entry, posting, query });
      }

      await sleep(500); // Rate limit between queries
    }

    await sleep(500); // Rate limit between companies
  }

  log('fetch', 'info', `\n  Collected ${collected.length} unique Workday jobs`);

  // Optionally fetch details
  if (fetchDetailsBool) {
    log('fetch', 'info', '  Fetching job details...');
    for (let i = 0; i < collected.length; i++) {
      const item = collected[i];
      if (item.posting.externalPath) {
        item.detail = await fetchJobDetail(item.entry, item.posting.externalPath);
        if (item.detail) {
          log('fetch', 'info', `    [${i + 1}/${collected.length}] Detail fetched for ${item.posting.title}`);
        }
        await sleep(300);
      }
    }
  }

  // Sort by date (approximate, parsed from "Posted X Days Ago")
  collected.sort((a, b) => {
    const aDate = parsePostedOn(a.posting.postedOn);
    const bDate = parsePostedOn(b.posting.postedOn);
    const aTime = aDate ? new Date(aDate).getTime() : 0;
    const bTime = bDate ? new Date(bDate).getTime() : 0;
    return bTime - aTime;
  });

  const from = options.range ? options.range.from : 1;
  const to = options.range ? options.range.to : Math.min(collected.length, options.limit ?? 50);
  const sliced = collected.slice(from - 1, to);

  log('fetch', 'info', `  Taking jobs ${from}–${to} out of ${collected.length} total`);

  const todayStr = new Date().toISOString().split('T')[0];

  const jobs: RawJob[] = sliced.map((item, idx) => {
    const { entry, posting, detail } = item;
    const datePosted = parsePostedOn(posting.postedOn) || todayStr;

    // Build full apply URL
    const applyLink = posting.externalPath
      ? buildJobUrl(entry, posting.externalPath)
      : `${buildBaseUrl(entry)}/${entry.site}`;

    // Extract description from detail or bulletFields
    let description: string | null = null;
    if (detail?.jobPostingInfo?.jobDescription) {
      description = detail.jobPostingInfo.jobDescription
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 5000);
    }

    const job: RawJob = {
      id: crypto.randomUUID(),
      positionTitle: posting.title || 'Unknown Position',
      company: entry.name,
      location: posting.locationsText || detail?.jobPostingInfo?.location || null,
      applyLink,
      datePosted,
      salary: null,
      rawFields: {
        source: 'workday',
        workdayTenant: entry.tenant,
        workdaySite: entry.site,
        jobReqId: posting.jobReqId || detail?.jobPostingInfo?.jobReqId || '',
        timeType: posting.timeType || '',
        postedOnRaw: posting.postedOn || '',
        bulletFields: posting.bulletFields?.join('; ') || '',
        ...(description ? { description: description.slice(0, 2000) } : {}),
      },
    };

    log('fetch', 'info', `  [${idx + 1}] ${job.company} — ${job.positionTitle} (${datePosted})`);
    return job;
  });

  writeStep('step1-raw-jobs', jobs);
  log('fetch', 'info', `\nStep 1 complete: ${jobs.length} jobs saved (source: Workday)`);
  return jobs.length;
}
