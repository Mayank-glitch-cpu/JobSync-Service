import { log } from '../logger.js';
import { readStep, writeStep } from '../store.js';
import type { RawJob } from '../types.js';

// Import all fetchers
import { fetchCsv } from './csv-fetcher.js';
import { fetchGitHub } from './github-fetcher.js';
import { fetchJSearch } from './jsearch-fetcher.js';
import { fetchYC } from './yc-fetcher.js';
import { fetchTheirStack } from './theirstack-fetcher.js';
import { fetchRemotive } from './remotive-fetcher.js';
import { fetchRemoteOK } from './remoteok-fetcher.js';
import { fetchAdzuna } from './adzuna-fetcher.js';
import { fetchHN } from './hn-fetcher.js';
import { fetchArbeitnow } from './arbeitnow-fetcher.js';
import { fetchUSAJobs } from './usajobs-fetcher.js';
import { fetchGreenhouse } from './greenhouse-fetcher.js';
import { fetchLever } from './lever-fetcher.js';
import { fetchLinkedIn } from './linkedin-fetcher.js';
import { fetchWellfound } from './wellfound-fetcher.js';
import { fetchHimalayas } from './himalayas-fetcher.js';
import { fetchJobicy } from './jobicy-fetcher.js';
import { fetchSmartRecruiters } from './smartrecruiters-fetcher.js';
import { fetchWorkday } from './workday-fetcher.js';
import { fetchRecruitee } from './recruitee-fetcher.js';
import { fetchWorkable } from './workable-fetcher.js';

export type SourceName =
  | 'csv'
  | 'github'
  | 'jsearch'
  | 'yc'
  | 'ashby'
  | 'remotive'
  | 'remoteok'
  | 'adzuna'
  | 'hackernews'
  | 'arbeitnow'
  | 'usajobs'
  | 'greenhouse'
  | 'lever'
  | 'linkedin'
  | 'wellfound'
  | 'himalayas'
  | 'jobicy'
  | 'smartrecruiters'
  | 'workday'
  | 'recruitee'
  | 'workable';

interface FetcherEntry {
  name: SourceName;
  label: string;
  fn: () => Promise<number>;
  requiresAuth: boolean;
  authEnvVars: string[];
}

/**
 * Registry of all available fetchers.
 * Each entry wraps the fetcher with default options.
 * Modify the fn() calls below to change per-source defaults.
 */
const FETCHER_REGISTRY: FetcherEntry[] = [
  {
    name: 'csv',
    label: 'Google Sheets CSV',
    fn: () => fetchCsv(20),
    requiresAuth: false,
    authEnvVars: [],
  },
  {
    name: 'github',
    label: 'SimplifyJobs GitHub',
    fn: () => fetchGitHub(),
    requiresAuth: false,
    authEnvVars: [],
  },
  {
    name: 'jsearch',
    label: 'JSearch (RapidAPI)',
    fn: () => fetchJSearch(),
    requiresAuth: true,
    authEnvVars: ['RAPIDAPI_KEY'],
  },
  {
    name: 'yc',
    label: 'Y Combinator Jobs',
    fn: () => fetchYC(),
    requiresAuth: true,
    authEnvVars: ['RAPIDAPI_KEY'],
  },
  {
    name: 'ashby',
    label: 'Ashby Job Boards',
    fn: () => fetchTheirStack({ limit: 30 }),
    requiresAuth: false,
    authEnvVars: [],
  },
  {
    name: 'remotive',
    label: 'Remotive',
    fn: () => fetchRemotive({ limit: 20 }),
    requiresAuth: false,
    authEnvVars: [],
  },
  {
    name: 'remoteok',
    label: 'RemoteOK',
    fn: () => fetchRemoteOK({ limit: 20, tags: ['engineer', 'developer', 'data', 'ml', 'robotics', 'ui', 'ux', 'ai'] }),
    requiresAuth: false,
    authEnvVars: [],
  },
  {
    name: 'adzuna',
    label: 'Adzuna',
    fn: () => fetchAdzuna({ limit: 20 }),
    requiresAuth: true,
    authEnvVars: ['ADZUNA_APP_ID', 'ADZUNA_APP_KEY'],
  },
  {
    name: 'hackernews',
    label: 'HackerNews Who is Hiring',
    fn: () => fetchHN({ limit: 30, keywords: ['engineer', 'ml', 'ai', 'data', 'backend', 'fullstack', 'robotics', 'ui', 'ux'] }),
    requiresAuth: false,
    authEnvVars: [],
  },
  {
    name: 'arbeitnow',
    label: 'Arbeitnow',
    fn: () => fetchArbeitnow({ limit: 20, keywords: ['engineer', 'developer', 'data', 'machine learning', 'robotics', 'ui', 'ux', 'ai'] }),
    requiresAuth: false,
    authEnvVars: [],
  },
  {
    name: 'usajobs',
    label: 'USAJobs (Federal)',
    fn: () => fetchUSAJobs({ limit: 15 }),
    requiresAuth: true,
    authEnvVars: ['USAJOBS_API_KEY', 'USAJOBS_EMAIL'],
  },
  {
    name: 'greenhouse',
    label: 'Greenhouse Boards',
    fn: () => fetchGreenhouse({ limit: 30, maxAgeDays: 3 }),
    requiresAuth: false,
    authEnvVars: [],
  },
  {
    name: 'lever',
    label: 'Lever Boards',
    fn: () => fetchLever({ limit: 30, maxAgeDays: 7 }),
    requiresAuth: false,
    authEnvVars: [],
  },
  {
    name: 'linkedin',
    label: 'LinkedIn (RapidAPI)',
    fn: () => fetchLinkedIn({ limit: 20, datePosted: 'pastWeek' }),
    requiresAuth: true,
    authEnvVars: ['RAPIDAPI_KEY'],
  },
  {
    name: 'wellfound',
    label: 'Wellfound (AngelList)',
    fn: () => fetchWellfound({ limit: 20 }),
    requiresAuth: false,
    authEnvVars: [],
  },
  {
    name: 'himalayas',
    label: 'Himalayas',
    fn: () => fetchHimalayas({ limit: 20 }),
    requiresAuth: false,
    authEnvVars: [],
  },
  {
    name: 'jobicy',
    label: 'Jobicy',
    fn: () => fetchJobicy({ limit: 20, tag: 'software-engineer' }),
    requiresAuth: false,
    authEnvVars: [],
  },
  {
    name: 'smartrecruiters',
    label: 'SmartRecruiters',
    fn: () => fetchSmartRecruiters({ limit: 30, maxAgeDays: 7 }),
    requiresAuth: false,
    authEnvVars: [],
  },
  {
    name: 'workday',
    label: 'Workday Boards',
    fn: () => fetchWorkday({ limit: 30, maxAgeDays: 7 }),
    requiresAuth: false,
    authEnvVars: [],
  },
  {
    name: 'recruitee',
    label: 'Recruitee',
    fn: () => fetchRecruitee({ limit: 30, maxAgeDays: 14 }),
    requiresAuth: false,
    authEnvVars: [],
  },
  {
    name: 'workable',
    label: 'Workable',
    fn: () => fetchWorkable({ limit: 30, maxAgeDays: 7 }),
    requiresAuth: false,
    authEnvVars: [],
  },
];

/**
 * Deduplicate jobs across sources using a composite key of company + title + apply link.
 * Prefers jobs from sources that appeared earlier in the list (higher priority).
 */
function deduplicateJobs(allJobs: RawJob[]): RawJob[] {
  const seen = new Map<string, RawJob>();

  for (const job of allJobs) {
    const companyNorm = (job.company || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const titleNorm = (job.positionTitle || '').toLowerCase().replace(/[^a-z0-9]/g, '');

    // Primary key: company + title
    const key1 = `${companyNorm}::${titleNorm}`;

    // Secondary key: apply link (if available)
    const linkNorm = (job.applyLink || '').toLowerCase().replace(/[?#].*$/, '');
    const key2 = linkNorm ? `link::${linkNorm}` : null;

    if (!seen.has(key1) && (!key2 || !seen.has(key2))) {
      seen.set(key1, job);
      if (key2) seen.set(key2, job);
    }
  }

  // Return unique values only (keys might map to same job)
  return Array.from(new Set(seen.values()));
}

export interface MultiSourceOptions {
  /** Which sources to include. If empty/undefined, uses all available. */
  sources?: SourceName[];
  /** Which sources to explicitly exclude. */
  excludeSources?: SourceName[];
  /** Continue on individual source failures instead of aborting. Default: true */
  continueOnError?: boolean;
}

/**
 * Run multiple fetchers, merge & deduplicate results, write to step1-raw-jobs.
 *
 * Usage:
 *   fetchMultiSource({ sources: ['github', 'greenhouse', 'lever', 'remotive'] })
 *   fetchMultiSource({ excludeSources: ['usajobs', 'wellfound'] })
 *   fetchMultiSource() // runs all sources with available credentials
 */
export async function fetchMultiSource(options: MultiSourceOptions = {}): Promise<number> {
  const continueOnError = options.continueOnError ?? true;

  // Determine which fetchers to run
  let fetchers = [...FETCHER_REGISTRY];

  if (options.sources?.length) {
    const sourceSet = new Set(options.sources);
    fetchers = fetchers.filter((f) => sourceSet.has(f.name));
  }

  if (options.excludeSources?.length) {
    const excludeSet = new Set(options.excludeSources);
    fetchers = fetchers.filter((f) => !excludeSet.has(f.name));
  }

  log('fetch', 'info', `=== Multi-Source Fetch: ${fetchers.length} sources ===`);
  log('fetch', 'info', `Sources: ${fetchers.map((f) => f.label).join(', ')}`);

  const allJobs: RawJob[] = [];
  const sourceStats: Array<{ name: string; count: number; status: 'ok' | 'error' | 'skipped' }> = [];

  for (const fetcher of fetchers) {
    log('fetch', 'info', `\n--- Source: ${fetcher.label} ---`);

    try {
      const count = await fetcher.fn();

      // Read the jobs that were just written by this fetcher
      const sourceJobs = readStep<RawJob[]>('step1-raw-jobs') || [];
      allJobs.push(...sourceJobs);
      sourceStats.push({ name: fetcher.label, count, status: 'ok' });

      log('fetch', 'info', `  ${fetcher.label}: ${count} jobs fetched`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('fetch', 'error', `  ${fetcher.label} FAILED: ${msg}`);
      sourceStats.push({ name: fetcher.label, count: 0, status: 'error' });

      if (!continueOnError) {
        throw new Error(`Multi-source fetch aborted: ${fetcher.label} failed — ${msg}`);
      }
    }
  }

  // Deduplicate across all sources
  const deduped = deduplicateJobs(allJobs);

  // Sort by datePosted descending, nulls last
  deduped.sort((a, b) => {
    const da = a.datePosted ? new Date(a.datePosted).getTime() : 0;
    const db = b.datePosted ? new Date(b.datePosted).getTime() : 0;
    return db - da;
  });

  // Write final combined result
  writeStep('step1-raw-jobs', deduped);

  // Summary
  log('fetch', 'info', '\n=== Multi-Source Summary ===');
  for (const stat of sourceStats) {
    const icon = stat.status === 'ok' ? '✓' : stat.status === 'error' ? '✗' : '○';
    log('fetch', 'info', `  ${icon} ${stat.name}: ${stat.count} jobs (${stat.status})`);
  }
  log('fetch', 'info', `  Total before dedup: ${allJobs.length}`);
  log('fetch', 'info', `  Total after dedup:  ${deduped.length}`);
  log('fetch', 'info', `Step 1 complete: ${deduped.length} jobs saved (multi-source)`);

  return deduped.length;
}
