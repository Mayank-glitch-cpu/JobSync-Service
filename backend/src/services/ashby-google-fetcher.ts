import crypto from 'node:crypto';
import * as cheerio from 'cheerio';
import { config } from '../config.js';
import { log } from '../logger.js';
import { writeStep } from '../store.js';
import type { RawJob } from '../types.js';

// ─── Ashby Posting API (no auth, public) ────────────────────────────────
const ASHBY_POSTING_API = 'https://api.ashbyhq.com/posting-api/job-board';

// ─── Google Custom Search JSON API ──────────────────────────────────────
const GOOGLE_CSE_URL = 'https://www.googleapis.com/customsearch/v1';

// ─── Search Domain Profiles ─────────────────────────────────────────────

interface SearchProfile {
  name: string;
  query: string;
  modifiers?: string;
}

const DEFAULT_SEARCH_PROFILES: SearchProfile[] = [
  {
    name: 'Software Engineer — New Grad',
    query: '"software" AND "new grad"',
  },
  {
    name: 'Software Engineer — Entry Level',
    query: '"software engineer" AND ("entry level" OR "junior" OR "early career")',
  },
  {
    name: 'ML / AI Engineer',
    query: '"machine learning" OR "ML engineer" OR "AI engineer" OR "deep learning"',
  },
  {
    name: 'Data Scientist / Data Engineer',
    query: '"data scientist" OR "data engineer" OR "analytics engineer"',
  },
  {
    name: 'Backend / Full-Stack Engineer',
    query: '"backend engineer" OR "full stack" OR "fullstack" OR "platform engineer"',
  },
  {
    name: 'Product Manager',
    query: '"product manager" OR "APM" OR "associate product manager"',
  },
  {
    name: 'Robotics Engineer',
    query: '"robotics" OR "robotics engineer" OR "perception engineer" OR "motion planning"',
  },
  {
    name: 'Embedded / Firmware Engineer',
    query: '"embedded" OR "firmware" OR "embedded software" OR "RTOS"',
  },
  {
    name: 'DevOps / Infra / SRE',
    query: '"devops" OR "SRE" OR "site reliability" OR "infrastructure engineer" OR "platform"',
  },
  {
    name: 'Security Engineer',
    query: '"security engineer" OR "application security" OR "infosec"',
  },
];

// ─── Types ──────────────────────────────────────────────────────────────

interface DiscoveredPosting {
  url: string;
  title: string;
  snippet: string;
  slug: string;
  jobId: string;
  profile: string;
}

interface AshbyJobDetail {
  id: string;
  title: string;
  location: string | null;
  department: string | null;
  team: string | null;
  descriptionPlain: string | null;
  publishedAt: string | null;
  applyUrl: string | null;
  compensation: string | null;
  isListed: boolean;
}

interface GoogleSearchItem {
  title: string;
  link: string;
  snippet: string;
  pagemap?: Record<string, unknown>;
}

interface GoogleSearchResponse {
  items?: GoogleSearchItem[];
  searchInformation?: { totalResults: string };
  queries?: { nextPage?: Array<{ startIndex: number }> };
}

// ─── URL Parsing ────────────────────────────────────────────────────────

function parseAshbyUrl(url: string): { slug: string; jobId: string } | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'jobs.ashbyhq.com') return null;

    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length !== 2) return null;

    const [slug, jobId] = segments;

    if (['application', 'info', 'about', 'embed'].includes(slug)) return null;
    if (slug.startsWith('_')) return null;
    if (jobId.length < 8) return null;

    return { slug, jobId };
  } catch {
    return null;
  }
}

function slugToCompanyName(slug: string): string {
  return slug
    .split(/[-._]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

// ─── Google Custom Search ───────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function searchGoogle(
  profile: SearchProfile,
  apiKey: string,
  cseId: string,
  maxResults: number
): Promise<DiscoveredPosting[]> {
  const discovered: DiscoveredPosting[] = [];
  const baseQuery = `site:jobs.ashbyhq.com -inurl:/application ${profile.query}`;

  const pages = Math.ceil(Math.min(maxResults, 100) / 10);

  for (let page = 0; page < pages; page++) {
    const startIndex = page * 10 + 1;

    const params = new URLSearchParams({
      key: apiKey,
      cx: cseId,
      q: baseQuery,
      start: String(startIndex),
      num: '10',
      dateRestrict: 'd7',
    });

    log('fetch', 'info', `    Google CSE page ${page + 1}/${pages} for "${profile.name}"...`);

    try {
      const response = await fetch(`${GOOGLE_CSE_URL}?${params}`, {
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        log('fetch', 'warn', `    Google CSE returned ${response.status}: ${errText.slice(0, 200)}`);
        break;
      }

      const result: GoogleSearchResponse = await response.json();
      const items = result.items || [];

      if (items.length === 0) {
        log('fetch', 'info', `    No more results for "${profile.name}"`);
        break;
      }

      for (const item of items) {
        const parsed = parseAshbyUrl(item.link);
        if (!parsed) continue;

        discovered.push({
          url: item.link,
          title: item.title,
          snippet: item.snippet || '',
          slug: parsed.slug,
          jobId: parsed.jobId,
          profile: profile.name,
        });
      }

      if (!result.queries?.nextPage) break;
    } catch (err) {
      log('fetch', 'error', `    Google search error: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }

    await sleep(250);
  }

  return discovered;
}

// ─── Fallback: SerpAPI via RapidAPI ─────────────────────────────────────

const SERP_API_URL = 'https://google-search74.p.rapidapi.com/';

async function searchSerpApi(
  profile: SearchProfile,
  rapidApiKey: string,
  maxResults: number
): Promise<DiscoveredPosting[]> {
  const discovered: DiscoveredPosting[] = [];
  const query = `site:jobs.ashbyhq.com -inurl:/application ${profile.query}`;

  const pages = Math.ceil(Math.min(maxResults, 30) / 10);

  for (let page = 0; page < pages; page++) {
    const params = new URLSearchParams({
      query,
      limit: '10',
      related_keywords: 'false',
    });

    if (page > 0) {
      params.set('page', String(page + 1));
    }

    log('fetch', 'info', `    SERP API page ${page + 1}/${pages} for "${profile.name}"...`);

    try {
      const response = await fetch(`${SERP_API_URL}?${params}`, {
        headers: {
          'x-rapidapi-host': 'google-search74.p.rapidapi.com',
          'x-rapidapi-key': rapidApiKey,
        },
      });

      if (!response.ok) {
        log('fetch', 'warn', `    SERP API returned ${response.status}`);
        break;
      }

      const result = await response.json();
      const items: Array<{ url: string; title: string; description: string }> =
        result.results || result.organic || [];

      if (items.length === 0) break;

      for (const item of items) {
        const parsed = parseAshbyUrl(item.url);
        if (!parsed) continue;

        discovered.push({
          url: item.url,
          title: item.title || '',
          snippet: item.description || '',
          slug: parsed.slug,
          jobId: parsed.jobId,
          profile: profile.name,
        });
      }
    } catch (err) {
      log('fetch', 'error', `    SERP API error: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }

    await sleep(500);
  }

  return discovered;
}

// ─── Fetch Job Details from Ashby ───────────────────────────────────────

async function fetchJobDetail(
  slug: string,
  jobId: string
): Promise<AshbyJobDetail | null> {
  // Strategy 1: Use Ashby board API
  try {
    const boardUrl = `${ASHBY_POSTING_API}/${slug}?includeCompensation=true`;
    const response = await fetch(boardUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'JobSync-Service/1.0',
      },
    });

    if (response.ok) {
      const data: { jobs?: Array<Record<string, unknown>> } = await response.json();
      const jobs = data.jobs || [];

      const match = jobs.find(
        (j: Record<string, unknown>) => j.id === jobId
      );

      if (match) {
        const loc = match.location as
          | { locationName?: string; location?: string }
          | string
          | null;
        let locationStr: string | null = null;
        if (typeof loc === 'string') locationStr = loc || null;
        else if (loc) locationStr = loc.locationName || loc.location || null;

        const comp = match.compensation as { summary?: string } | null;

        return {
          id: jobId,
          title: (match.title as string) || '',
          location: locationStr,
          department: (match.department as string) || null,
          team: (match.team as string) || null,
          descriptionPlain: (match.descriptionPlain as string) || null,
          publishedAt: (match.publishedAt as string) || null,
          applyUrl: (match.applyUrl as string) || null,
          compensation: comp?.summary || null,
          isListed: true,
        };
      }
    }
  } catch {
    // Fall through to scraping
  }

  // Strategy 2: Scrape the individual posting page HTML
  try {
    const pageUrl = `https://jobs.ashbyhq.com/${slug}/${jobId}`;
    const response = await fetch(pageUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html',
      },
    });

    if (!response.ok) return null;

    const html = await response.text();
    const $ = cheerio.load(html);

    let structuredData: Record<string, unknown> | null = null;
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const parsed = JSON.parse($(el).html() || '{}');
        if (parsed['@type'] === 'JobPosting') {
          structuredData = parsed;
        }
      } catch { /* skip */ }
    });

    if (structuredData) {
      const sd = structuredData as Record<string, unknown>;
      const loc = sd.jobLocation as Record<string, unknown> | undefined;
      const addr = loc?.address as Record<string, string> | undefined;
      const baseSalary = sd.baseSalary as Record<string, unknown> | undefined;

      let salaryStr: string | null = null;
      if (baseSalary) {
        const value = baseSalary.value as Record<string, unknown> | undefined;
        if (value?.minValue && value?.maxValue) {
          salaryStr = `$${Number(value.minValue).toLocaleString()}–$${Number(value.maxValue).toLocaleString()}/${(value.unitText as string) || 'yr'}`;
        }
      }

      return {
        id: jobId,
        title: (sd.title as string) || '',
        location: addr
          ? [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(Boolean).join(', ')
          : null,
        department: null,
        team: null,
        descriptionPlain: (sd.description as string)?.replace(/<[^>]+>/g, ' ').slice(0, 5000) || null,
        publishedAt: (sd.datePosted as string) || null,
        applyUrl: `https://jobs.ashbyhq.com/${slug}/${jobId}`,
        compensation: salaryStr,
        isListed: true,
      };
    }

    // Fallback: extract from HTML elements
    const title = $('h1').first().text().trim();
    const location = $('[class*="location"], [data-testid="location"]').first().text().trim() || null;
    const descriptionEl = $('[class*="description"], [class*="posting-"]').first();
    const description = descriptionEl.text().replace(/\s+/g, ' ').trim().slice(0, 5000) || null;

    if (title) {
      return {
        id: jobId,
        title,
        location,
        department: null,
        team: null,
        descriptionPlain: description,
        publishedAt: null,
        applyUrl: `https://jobs.ashbyhq.com/${slug}/${jobId}`,
        compensation: null,
        isListed: true,
      };
    }
  } catch {
    // Scraping failed
  }

  return null;
}

// ─── Board-level cache to avoid re-fetching the same company ────────────

const boardCache = new Map<string, Map<string, AshbyJobDetail>>();

async function fetchJobDetailCached(
  slug: string,
  jobId: string
): Promise<AshbyJobDetail | null> {
  if (boardCache.has(slug)) {
    const jobs = boardCache.get(slug)!;
    return jobs.get(jobId) || null;
  }

  try {
    const boardUrl = `${ASHBY_POSTING_API}/${slug}?includeCompensation=true`;
    const response = await fetch(boardUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'JobSync-Service/1.0',
      },
    });

    if (response.ok) {
      const data: { jobs?: Array<Record<string, unknown>> } = await response.json();
      const jobsMap = new Map<string, AshbyJobDetail>();

      for (const match of data.jobs || []) {
        const id = match.id as string;
        const loc = match.location as
          | { locationName?: string; location?: string }
          | string
          | null;
        let locationStr: string | null = null;
        if (typeof loc === 'string') locationStr = loc || null;
        else if (loc) locationStr = loc.locationName || loc.location || null;

        const comp = match.compensation as { summary?: string } | null;

        jobsMap.set(id, {
          id,
          title: (match.title as string) || '',
          location: locationStr,
          department: (match.department as string) || null,
          team: (match.team as string) || null,
          descriptionPlain: (match.descriptionPlain as string) || null,
          publishedAt: (match.publishedAt as string) || null,
          applyUrl: (match.applyUrl as string) || null,
          compensation: comp?.summary || null,
          isListed: true,
        });
      }

      boardCache.set(slug, jobsMap);
      return jobsMap.get(jobId) || null;
    }
  } catch {
    // Fall through
  }

  const detail = await fetchJobDetail(slug, jobId);
  if (detail) {
    const map = new Map<string, AshbyJobDetail>();
    map.set(jobId, detail);
    boardCache.set(slug, map);
  }
  return detail;
}

// ─── Main Export ────────────────────────────────────────────────────────

export interface FetchAshbyGoogleOptions {
  range?: { from: number; to: number };
  limit?: number;
  profiles?: SearchProfile[];
  profileNames?: string[];
  resultsPerProfile?: number;
  cseId?: string;
  googleApiKey?: string;
  searchBackend?: 'google-cse' | 'serpapi';
  skipEnrichment?: boolean;
  extraProfiles?: SearchProfile[];
  globalKeywords?: string[];
  maxAgeDays?: number;
}

export async function fetchAshbyGoogle(options: FetchAshbyGoogleOptions = {}): Promise<number> {
  // ── Resolve search profiles ────────────────────────────────────────
  let profiles: SearchProfile[];

  if (options.profiles) {
    profiles = options.profiles;
  } else if (options.profileNames?.length) {
    const nameSet = new Set(options.profileNames.map((n) => n.toLowerCase()));
    profiles = DEFAULT_SEARCH_PROFILES.filter((p) =>
      nameSet.has(p.name.toLowerCase())
    );
  } else {
    profiles = [...DEFAULT_SEARCH_PROFILES];
  }

  if (options.extraProfiles?.length) {
    profiles.push(...options.extraProfiles);
  }

  if (options.globalKeywords?.length) {
    const globalClause = options.globalKeywords.map((k) => `"${k}"`).join(' OR ');
    profiles = profiles.map((p) => ({
      ...p,
      query: `(${p.query}) AND (${globalClause})`,
    }));
  }

  const resultsPerProfile = options.resultsPerProfile ?? 20;
  const skipEnrichment = options.skipEnrichment ?? false;
  const maxAgeDays = options.maxAgeDays ?? 0;
  const jobLimit = options.limit ?? 50;

  // ── Resolve search backend ─────────────────────────────────────────
  const backend = options.searchBackend ?? 'google-cse';
  const googleApiKey = options.googleApiKey || config.googleApiKey || '';
  const cseId = options.cseId || config.googleCseId || '';
  const rapidApiKey = config.rapidApiKey || '';

  if (backend === 'google-cse' && (!googleApiKey || !cseId)) {
    if (rapidApiKey) {
      log('fetch', 'warn', 'Google CSE credentials missing, falling back to SerpAPI via RapidAPI');
    } else {
      throw new Error(
        'Ashby Google search requires either:\n' +
          '  • GOOGLE_API_KEY + GOOGLE_CSE_ID (for Google Custom Search), or\n' +
          '  • RAPIDAPI_KEY (for SerpAPI fallback)\n' +
          'Set these in your .env file.'
      );
    }
  }

  const useGoogleCse = backend === 'google-cse' && googleApiKey && cseId;

  log('fetch', 'info', '═══════════════════════════════════════════════════');
  log('fetch', 'info', ' Ashby Google Search Discovery');
  log('fetch', 'info', `  Backend:  ${useGoogleCse ? 'Google Custom Search' : 'SerpAPI (RapidAPI)'}`);
  log('fetch', 'info', `  Profiles: ${profiles.length}`);
  log('fetch', 'info', `  Per-profile limit: ${resultsPerProfile}`);
  log('fetch', 'info', `  Total job limit: ${jobLimit}`);
  log('fetch', 'info', `  Enrichment: ${skipEnrichment ? 'OFF' : 'ON'}`);
  log('fetch', 'info', '═══════════════════════════════════════════════════');

  // ── Phase 1: Google Search Discovery ───────────────────────────────
  const allDiscovered: DiscoveredPosting[] = [];

  for (const profile of profiles) {
    log('fetch', 'info', `\n  ▸ Searching: ${profile.name}`);
    log('fetch', 'info', `    Query: site:jobs.ashbyhq.com -inurl:/application ${profile.query}`);

    let results: DiscoveredPosting[];

    if (useGoogleCse) {
      results = await searchGoogle(profile, googleApiKey, cseId, resultsPerProfile);
    } else {
      results = await searchSerpApi(profile, rapidApiKey, resultsPerProfile);
    }

    log('fetch', 'info', `    Found: ${results.length} Ashby job URLs`);
    allDiscovered.push(...results);

    await sleep(400);
  }

  // ── Deduplicate by jobId ───────────────────────────────────────────
  const dedupedMap = new Map<string, DiscoveredPosting>();
  for (const posting of allDiscovered) {
    if (!dedupedMap.has(posting.jobId)) {
      dedupedMap.set(posting.jobId, posting);
    }
  }
  const deduped = Array.from(dedupedMap.values());

  log('fetch', 'info', `\n  Discovery complete: ${allDiscovered.length} raw → ${deduped.length} unique postings`);

  // ── Phase 2: Enrich from Ashby API ─────────────────────────────────
  const bySlug = new Map<string, DiscoveredPosting[]>();
  for (const posting of deduped) {
    if (!bySlug.has(posting.slug)) {
      bySlug.set(posting.slug, []);
    }
    bySlug.get(posting.slug)!.push(posting);
  }

  log('fetch', 'info', `  Companies discovered: ${bySlug.size}`);
  log('fetch', 'info', `  ${[...bySlug.entries()].map(([slug, posts]) => `${slug} (${posts.length})`).join(', ')}`);

  interface EnrichedJob {
    discovered: DiscoveredPosting;
    detail: AshbyJobDetail | null;
    companyName: string;
  }

  const enriched: EnrichedJob[] = [];
  boardCache.clear();

  if (!skipEnrichment) {
    for (const [slug, postings] of bySlug) {
      const companyName = slugToCompanyName(slug);
      log('fetch', 'info', `\n  ▸ Enriching ${companyName} (${slug}) — ${postings.length} jobs`);

      for (const posting of postings) {
        const detail = await fetchJobDetailCached(slug, posting.jobId);
        enriched.push({ discovered: posting, detail, companyName });

        if (detail) {
          log('fetch', 'info', `    ✓ ${detail.title} — ${detail.location || 'No location'}`);
        } else {
          log('fetch', 'warn', `    ✗ ${posting.jobId} — Could not enrich, using snippet data`);
        }
      }

      await sleep(300);
    }
  } else {
    for (const posting of deduped) {
      enriched.push({
        discovered: posting,
        detail: null,
        companyName: slugToCompanyName(posting.slug),
      });
    }
  }

  // ── Phase 3: Filter & Convert to RawJob ────────────────────────────
  const cutoffDate = maxAgeDays > 0
    ? new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000)
    : null;

  const filtered = enriched.filter(({ detail }) => {
    if (!cutoffDate) return true;
    if (!detail?.publishedAt) return true;
    const pubDate = new Date(detail.publishedAt);
    return !Number.isNaN(pubDate.getTime()) && pubDate >= cutoffDate;
  });

  filtered.sort((a, b) => {
    const aTime = a.detail?.publishedAt ? Date.parse(a.detail.publishedAt) : 0;
    const bTime = b.detail?.publishedAt ? Date.parse(b.detail.publishedAt) : 0;
    return bTime - aTime;
  });

  const from = options.range ? options.range.from : 1;
  const to = options.range ? options.range.to : Math.min(filtered.length, jobLimit);
  const sliced = filtered.slice(from - 1, to);

  log('fetch', 'info', `\n  After filtering: ${filtered.length} jobs, taking ${from}–${to}`);

  const todayStr = new Date().toISOString().split('T')[0];

  const jobs: RawJob[] = sliced.map((entry, idx) => {
    const { discovered, detail, companyName } = entry;

    const title =
      detail?.title || discovered.title.replace(/ - .+$/, '').trim() || 'Unknown Position';

    const job: RawJob = {
      id: crypto.randomUUID(),
      positionTitle: title,
      company: companyName,
      location: detail?.location || null,
      applyLink: detail?.applyUrl || discovered.url,
      datePosted: detail?.publishedAt?.split('T')[0] || todayStr,
      salary: detail?.compensation || null,
      rawFields: {
        source: 'ashby-google-search',
        ashbyJobId: discovered.jobId,
        ashbySlug: discovered.slug,
        searchProfile: discovered.profile,
        department: detail?.department || '',
        team: detail?.team || '',
        snippet: discovered.snippet.slice(0, 500),
        enriched: String(!!detail),
      },
    };

    log(
      'fetch',
      'info',
      `  [${idx + 1}] ${job.company} — ${job.positionTitle}${detail ? '' : ' (snippet only)'}`
    );
    return job;
  });

  writeStep('step1-raw-jobs', jobs);

  const enrichedCount = sliced.filter((e) => !!e.detail).length;
  log('fetch', 'info', '\n═══════════════════════════════════════════════════');
  log('fetch', 'info', ` Step 1 complete: ${jobs.length} jobs saved (source: Ashby Google Search)`);
  log('fetch', 'info', `   Enriched: ${enrichedCount} | Snippet-only: ${jobs.length - enrichedCount}`);
  log('fetch', 'info', `   Companies: ${bySlug.size} | Profiles searched: ${profiles.length}`);
  log('fetch', 'info', '═══════════════════════════════════════════════════');

  return jobs.length;
}
