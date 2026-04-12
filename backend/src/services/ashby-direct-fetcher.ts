import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../logger.js';
import { writeStep } from '../store.js';
import type { RawJob } from '../types.js';
import { passesTitleFilter } from './job-filter.js';

const ASHBY_POSTING_API = 'https://api.ashbyhq.com/posting-api/job-board';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SLUGS_PATH = path.resolve(__dirname, '../../data/ashby-slugs.json');

interface SlugEntry {
  slug: string;
  name: string;
  verified?: boolean;
  jobCount?: number;
}

interface AshbyBoardJob {
  id: string;
  title: string;
  location?: string | { locationName?: string; location?: string } | null;
  department?: string | null;
  team?: string | null;
  descriptionPlain?: string | null;
  publishedAt?: string | null;
  applyUrl?: string | null;
  jobUrl?: string | null;
  compensation?: { summary?: string } | null;
  employmentType?: string | null;
  isListed?: boolean;
}

export interface FetchAshbyDirectOptions {
  limit?: number;
  range?: { from: number; to: number };
  maxAgeDays?: number;
  slugs?: string[];
  /** Override include keywords (defaults to config.ashbyIncludeKeywords). */
  keywords?: string[];
  /** Override exclude keywords (defaults to config.ashbyExcludeKeywords). */
  excludeKeywords?: string[];
  /** Require a new-grad/entry-level marker in the title (defaults to config.ashbyNewGradOnly). */
  newGradOnly?: boolean;
  concurrency?: number;
}

function locationToString(loc: AshbyBoardJob['location']): string | null {
  if (!loc) return null;
  if (typeof loc === 'string') return loc || null;
  return loc.locationName || loc.location || null;
}


async function fetchBoard(slug: string): Promise<AshbyBoardJob[]> {
  const url = `${ASHBY_POSTING_API}/${slug}?includeCompensation=true`;
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'JobSync-Service/1.0',
      },
    });
    if (!response.ok) {
      log('fetch', 'warn', `    ${slug}: HTTP ${response.status}`);
      return [];
    }
    const data: { jobs?: AshbyBoardJob[] } = await response.json();
    return data.jobs || [];
  } catch (err) {
    log('fetch', 'warn', `    ${slug}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

async function mapLimit<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function fetchAshbyDirect(options: FetchAshbyDirectOptions = {}): Promise<number> {
  const limit = options.limit ?? 50;
  const maxAgeDays = options.maxAgeDays ?? 0;
  const include = options.keywords ?? config.ashbyIncludeKeywords;
  const exclude = options.excludeKeywords ?? config.ashbyExcludeKeywords;
  const newGradOnly = options.newGradOnly ?? config.ashbyNewGradOnly;
  const newGradKeywords = config.ashbyNewGradKeywords;
  const concurrency = options.concurrency ?? 6;

  const raw = await readFile(SLUGS_PATH, 'utf-8');
  const allEntries: SlugEntry[] = JSON.parse(raw);

  let entries = allEntries.filter((e) => e.verified !== false);
  if (options.slugs?.length) {
    const want = new Set(options.slugs.map((s) => s.toLowerCase()));
    entries = entries.filter((e) => want.has(e.slug.toLowerCase()));
  }

  log('fetch', 'info', '═══════════════════════════════════════════════════');
  log('fetch', 'info', ' Ashby Direct Fetcher (no search)');
  log('fetch', 'info', `  Slugs: ${entries.length}`);
  log('fetch', 'info', `  Concurrency: ${concurrency}`);
  log('fetch', 'info', `  maxAgeDays: ${maxAgeDays || 'none'}`);
  log('fetch', 'info', `  Limit: ${limit}`);
  log('fetch', 'info', `  Filter: newGradOnly=${newGradOnly}, include=${include.length}, exclude=${exclude.length}`);
  log('fetch', 'info', '═══════════════════════════════════════════════════');

  const boards = await mapLimit(entries, concurrency, async (entry) => {
    const jobs = await fetchBoard(entry.slug);
    log('fetch', 'info', `  ${entry.name} (${entry.slug}): ${jobs.length} jobs`);
    return { entry, jobs };
  });

  const cutoff = maxAgeDays > 0 ? Date.now() - maxAgeDays * 24 * 60 * 60 * 1000 : 0;
  const todayStr = new Date().toISOString().split('T')[0];

  interface Flat {
    entry: SlugEntry;
    job: AshbyBoardJob;
    publishedMs: number;
  }

  const flat: Flat[] = [];
  for (const { entry, jobs } of boards) {
    for (const job of jobs) {
      if (!passesTitleFilter(job, { include, exclude, newGradKeywords, newGradOnly })) continue;
      const publishedMs = job.publishedAt ? Date.parse(job.publishedAt) : 0;
      if (cutoff && publishedMs && publishedMs < cutoff) continue;
      flat.push({ entry, job, publishedMs: Number.isNaN(publishedMs) ? 0 : publishedMs });
    }
  }

  flat.sort((a, b) => b.publishedMs - a.publishedMs);

  const from = options.range ? options.range.from : 1;
  const to = options.range ? options.range.to : Math.min(flat.length, limit);
  const sliced = flat.slice(from - 1, to);

  log('fetch', 'info', `  Matched ${flat.length} jobs across ${boards.length} boards → taking ${from}-${to}`);

  const rawJobs: RawJob[] = sliced.map(({ entry, job }) => ({
    id: crypto.randomUUID(),
    positionTitle: job.title || 'Unknown Position',
    company: entry.name,
    location: locationToString(job.location),
    applyLink: job.applyUrl || job.jobUrl || `https://jobs.ashbyhq.com/${entry.slug}/${job.id}`,
    datePosted: job.publishedAt?.split('T')[0] || todayStr,
    salary: job.compensation?.summary || null,
    rawFields: {
      source: 'ashby-direct',
      ashbyJobId: job.id,
      ashbySlug: entry.slug,
      department: job.department || '',
      team: job.team || '',
      employmentType: job.employmentType || '',
      descriptionSnippet: (job.descriptionPlain || '').slice(0, 500),
    },
  }));

  writeStep('step1-raw-jobs', rawJobs);

  log('fetch', 'info', '═══════════════════════════════════════════════════');
  log('fetch', 'info', ` Step 1 complete: ${rawJobs.length} jobs (source: ashby-direct)`);
  log('fetch', 'info', '═══════════════════════════════════════════════════');

  return rawJobs.length;
}
