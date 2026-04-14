import crypto from 'node:crypto';
import { log } from '../logger.js';
import { writeStep } from '../store.js';
import type { RawJob } from '../types.js';

// Arbeitnow — free public JSON API, no auth
const ARBEITNOW_API_URL = 'https://www.arbeitnow.com/api/job-board-api';

interface ArbeitnowJob {
  slug: string;
  company_name: string;
  title: string;
  description: string;
  remote: boolean;
  url: string;
  tags: string[];
  job_types: string[];
  location: string;
  created_at: number; // Unix timestamp
}

interface ArbeitnowResponse {
  data: ArbeitnowJob[];
  links: { next: string | null };
  meta: { current_page: number; last_page: number; total: number };
}

export interface FetchArbeitnowOptions {
  range?: { from: number; to: number };
  limit?: number;
  keywords?: string[];
  pages?: number;
}

export async function fetchArbeitnow(options: FetchArbeitnowOptions = {}): Promise<number> {
  const numPages = options.pages ?? 3;
  const keywords = (options.keywords ?? []).map((k) => k.toLowerCase());

  log('fetch', 'info', `Fetching jobs from Arbeitnow API (pages: ${numPages})...`);

  const allJobs: ArbeitnowJob[] = [];

  for (let page = 1; page <= numPages; page++) {
    const url = `${ARBEITNOW_API_URL}?page=${page}`;
    log('fetch', 'info', `  Fetching page ${page}/${numPages}...`);

    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        log('fetch', 'warn', `  Arbeitnow returned ${response.status} on page ${page}`);
        break;
      }

      const result: ArbeitnowResponse = await response.json();
      if (result.data?.length) {
        allJobs.push(...result.data);
      }

      if (page >= result.meta.last_page) break;
    } catch (err) {
      log('fetch', 'error', `  Page ${page} failed: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }

    await new Promise((r) => setTimeout(r, 400));
  }

  log('fetch', 'info', `Received ${allJobs.length} jobs from Arbeitnow`);

  // Keyword filter
  const filtered = keywords.length > 0
    ? allJobs.filter((job) => {
        const hay = `${job.title} ${job.company_name} ${job.tags.join(' ')}`.toLowerCase();
        return keywords.some((kw) => hay.includes(kw));
      })
    : allJobs;

  // Sort by created_at descending
  filtered.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

  log('fetch', 'info', `${filtered.length} jobs after keyword filter`);

  const from = options.range ? options.range.from : 1;
  const to = options.range ? options.range.to : Math.min(filtered.length, options.limit ?? 20);
  const sliced = filtered.slice(from - 1, to);

  log('fetch', 'info', `Taking jobs ${from}–${to} out of ${filtered.length} total`);

  const jobs: RawJob[] = sliced.map((item, idx) => {
    const dateStr = item.created_at
      ? new Date(item.created_at * 1000).toISOString().split('T')[0]
      : null;

    const job: RawJob = {
      id: crypto.randomUUID(),
      positionTitle: item.title || 'Unknown Position',
      company: item.company_name || 'Unknown Company',
      location: item.remote ? 'Remote' : item.location || null,
      applyLink: item.url || null,
      datePosted: dateStr,
      salary: null,
      rawFields: {
        source: 'arbeitnow',
        arbeitnowSlug: item.slug,
        tags: item.tags?.join(', ') || '',
        jobTypes: item.job_types?.join(', ') || '',
        remote: String(item.remote),
      },
    };

    log('fetch', 'info', `  [${idx + 1}] ${job.company} — ${job.positionTitle}`);
    return job;
  });

  writeStep('step1-raw-jobs', jobs);
  log('fetch', 'info', `Step 1 complete: ${jobs.length} jobs saved (source: Arbeitnow)`);
  return jobs.length;
}
