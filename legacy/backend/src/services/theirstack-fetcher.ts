import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { log } from '../logger.js';
import { writeStep } from '../store.js';
import type { RawJob } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASHBY_SLUGS_PATH = path.join(__dirname, '../../data/ashby-slugs.json');
const ASHBY_PUBLIC_API_BASE = 'https://api.ashbyhq.com/posting-api/job-board';

interface AshbySlugEntry {
  slug: string;
  name: string;
  verified?: boolean;
  lastVerified?: string;
}

function loadAshbySlugs(): AshbySlugEntry[] {
  try {
    const raw = fs.readFileSync(ASHBY_SLUGS_PATH, 'utf-8');
    const entries: AshbySlugEntry[] = JSON.parse(raw);
    return entries.filter((e) => e.slug && e.name);
  } catch (err) {
    log('fetch', 'warn', `Failed to load ashby-slugs.json: ${err}`);
    return [];
  }
}

interface AshbyLocation {
  location?: string;
  locationName?: string;
}

interface AshbyCompensation {
  summary?: string;
}

interface AshbyJobPosting {
  id: string;
  title?: string;
  applyUrl?: string;
  location?: AshbyLocation | string | null;
  department?: string | null;
  team?: string | null;
  descriptionPlain?: string | null;
  publishedAt?: string | null;
  compensation?: AshbyCompensation | null;
}

interface AshbyPublicResponse {
  jobs?: AshbyJobPosting[];
}

interface CompanyPosting {
  company: string;
  slug: string;
  posting: AshbyJobPosting;
}

export interface FetchAshbyOptions {
  range?: { from: number; to: number };
  limit?: number;
  keywords?: string[];
  companySlugs?: string[];
  publishedWithinHours?: number;
  postedTodayOnly?: boolean;
}

function normalizeText(value: string | null | undefined): string {
  return (value || '').trim().toLowerCase();
}

function normalizeKeywords(input?: string[]): string[] {
  if (!input || input.length === 0) {
    return config.ashbyKeywords;
  }

  return input
    .map((keyword) => keyword.trim().toLowerCase())
    .filter(Boolean);
}

function hasKeywordMatch(posting: AshbyJobPosting, keywords: string[]): boolean {
  if (keywords.length === 0) {
    return true;
  }

  const haystack = [posting.title, posting.department, posting.team, posting.descriptionPlain]
    .map((field) => normalizeText(field))
    .join(' ');

  return keywords.some((keyword) => haystack.includes(keyword));
}

function hasExcludedKeyword(posting: AshbyJobPosting, excludeKeywords: string[]): boolean {
  if (excludeKeywords.length === 0) return false;
  const title = normalizeText(posting.title);
  return excludeKeywords.some((keyword) => title.includes(keyword));
}

function isPublishedTodayUTC(publishedAt: string | null | undefined): boolean {
  if (!publishedAt) {
    return false;
  }

  const publishedDate = new Date(publishedAt);
  if (Number.isNaN(publishedDate.getTime())) {
    return false;
  }

  const now = new Date();
  return (
    publishedDate.getUTCFullYear() === now.getUTCFullYear() &&
    publishedDate.getUTCMonth() === now.getUTCMonth() &&
    publishedDate.getUTCDate() === now.getUTCDate()
  );
}

function isWithinLookback(
  publishedAt: string | null | undefined,
  lookbackHours: number
): boolean {
  if (!publishedAt) {
    return false;
  }

  const publishedTime = Date.parse(publishedAt);
  if (Number.isNaN(publishedTime)) {
    return false;
  }

  if (lookbackHours <= 0) {
    return true;
  }

  const cutoff = Date.now() - lookbackHours * 60 * 60 * 1000;
  return publishedTime >= cutoff;
}

function extractLocation(location: AshbyJobPosting['location']): string | null {
  if (!location) {
    return null;
  }

  if (typeof location === 'string') {
    return location === '' ? null : location;
  }

  return location.locationName || location.location || null;
}

function slugToCompanyName(slug: string): string {
  return slug
    .split(/[.-]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function resolveCompanies(selectedSlugs?: string[]): { slug: string; name: string }[] {
  const entries = loadAshbySlugs();
  const allCompanies = entries.map((e) => ({ slug: e.slug, name: e.name }));

  log('fetch', 'info', `Loaded ${allCompanies.length} company slugs from ashby-slugs.json`);

  if (!selectedSlugs || selectedSlugs.length === 0) {
    return allCompanies;
  }

  const selectedSet = new Set(selectedSlugs.map((slug) => slug.trim().toLowerCase()));
  return allCompanies.filter((company) => selectedSet.has(company.slug.toLowerCase()));
}

async function fetchCompanyJobs(
  slug: string,
  companyName: string,
  includeCompensation: boolean
): Promise<CompanyPosting[]> {
  const url = new URL(`${ASHBY_PUBLIC_API_BASE}/${slug}`);
  if (includeCompensation) {
    url.searchParams.set('includeCompensation', 'true');
  }

  try {
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'JobSync-Service/1.0',
      },
    });

    if (!response.ok) {
      log('fetch', 'warn', `  Ashby API returned ${response.status} for ${slug}`);
      return [];
    }

    const result: AshbyPublicResponse = await response.json();
    const postings = result.jobs ?? [];
    return postings.map((posting) => ({ company: companyName, slug, posting }));
  } catch (error) {
    log('fetch', 'error', `  Network error fetching ${slug}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

function toRawJob(entry: CompanyPosting): RawJob {
  const { company, slug, posting } = entry;

  return {
    id: crypto.randomUUID(),
    positionTitle: posting.title?.trim() || 'Unknown Position',
    company,
    location: extractLocation(posting.location),
    applyLink: posting.applyUrl || `https://jobs.ashbyhq.com/${slug}/${posting.id}`,
    datePosted: posting.publishedAt || null,
    salary: posting.compensation?.summary || null,
    rawFields: {
      source: 'ashby-posting-api',
      ashbyJobId: posting.id,
      ashbySlug: slug,
      department: posting.department || '',
      team: posting.team || '',
    },
  };
}

export async function fetchTheirStack(options: FetchAshbyOptions = {}): Promise<number> {
  const companies = resolveCompanies(options.companySlugs);
  const keywords = normalizeKeywords(options.keywords);
  const excludeKeywords = config.ashbyExcludeKeywords;
  const lookbackHours = options.publishedWithinHours ?? config.ashbyPublishedWithinHours;
  const postedTodayOnly = options.postedTodayOnly || false;

  log('fetch', 'info', `Fetching Ashby data for ${companies.length} selected companies...`);
  log(
    'fetch',
    'info',
    `Filters: keywords=${keywords.join(', ') || 'none'}, exclude=${excludeKeywords.join(', ') || 'none'}, postedTodayOnly=${postedTodayOnly}, publishedWithinHours=${lookbackHours}`
  );

  const collected: CompanyPosting[] = [];

  for (const { slug, name } of companies) {
    log('fetch', 'info', `  Fetching ${name} (${slug})...`);

    const entries = await fetchCompanyJobs(slug, name, config.ashbyIncludeCompensation);
    log('fetch', 'info', `  ${name}: ${entries.length} jobs returned by Ashby`);

    const filteredByKeyword = entries.filter(({ posting }) => hasKeywordMatch(posting, keywords));
    const filteredByExclusion = filteredByKeyword.filter(
      ({ posting }) => !hasExcludedKeyword(posting, excludeKeywords)
    );
    const filteredByDate = filteredByExclusion.filter(({ posting }) =>
      postedTodayOnly
        ? isPublishedTodayUTC(posting.publishedAt)
        : isWithinLookback(posting.publishedAt, lookbackHours)
    );

    log('fetch', 'info', `  ${name}: ${filteredByDate.length} jobs after filters (${filteredByKeyword.length - filteredByExclusion.length} excluded by title)`);

    collected.push(...filteredByDate);

    if (config.ashbyRequestDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, config.ashbyRequestDelayMs));
    }
  }

  const deduped = Array.from(new Map(collected.map((item) => [item.posting.id, item])).values())
    .sort((a, b) => {
      const aTime = Date.parse(a.posting.publishedAt || '') || 0;
      const bTime = Date.parse(b.posting.publishedAt || '') || 0;
      return bTime - aTime;
    });

  log('fetch', 'info', `Collected ${deduped.length} filtered Ashby jobs`);

  const from = options.range ? options.range.from : 1;
  const to = options.range
    ? options.range.to
    : Math.min(deduped.length, options.limit ?? config.jobCount);
  const sliced = deduped.slice(Math.max(0, from - 1), Math.max(0, to));

  log('fetch', 'info', `Taking jobs ${from}–${to} out of ${deduped.length} total`);

  const jobs: RawJob[] = sliced.map((entry, index) => {
    const job = toRawJob(entry);
    log('fetch', 'info', `  [${index + 1}] ${job.company} — ${job.positionTitle}`);
    return job;
  });

  writeStep('step1-raw-jobs', jobs);
  log('fetch', 'info', `Step 1 complete: ${jobs.length} jobs saved (source: Ashby)`);

  return jobs.length;
}
