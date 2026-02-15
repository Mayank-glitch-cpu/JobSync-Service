import crypto from 'node:crypto';
import { log } from '../logger.js';
import { writeStep } from '../store.js';
import type { RawJob } from '../types.js';

// Himalayas — free public JSON API for remote tech jobs
const HIMALAYAS_API_URL = 'https://himalayas.app/jobs/api';

interface HimalayasJob {
  id: string;
  title: string;
  companyName: string;
  companyLogo: string | null;
  categories: string[];
  tags: string[];
  locationRestrictions: string[];
  timezoneRestrictions: string[];
  seniority: string[];
  pubDate: string; // ISO date
  externalUrl: string;
  salary: string | null;
  description: string;
}

interface HimalayasResponse {
  jobs: HimalayasJob[];
  totalCount: number;
  offset: number;
  limit: number;
}

export interface FetchHimalayasOptions {
  range?: { from: number; to: number };
  limit?: number;
  categories?: string[];
  seniority?: string[];
}

export async function fetchHimalayas(options: FetchHimalayasOptions = {}): Promise<number> {
  const limit = options.limit ?? 25;

  log('fetch', 'info', `Fetching jobs from Himalayas API...`);

  const params = new URLSearchParams({
    limit: String(Math.min(limit, 50)),
    offset: '0',
  });

  // Add category filters if provided
  if (options.categories?.length) {
    for (const cat of options.categories) {
      params.append('categories', cat);
    }
  }

  if (options.seniority?.length) {
    for (const s of options.seniority) {
      params.append('seniority', s);
    }
  }

  const url = `${HIMALAYAS_API_URL}?${params}`;

  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`Himalayas API failed: ${response.status} ${response.statusText}`);
  }

  const result: HimalayasResponse = await response.json();
  const allJobs = result.jobs || [];

  log('fetch', 'info', `Received ${allJobs.length} jobs from Himalayas (total: ${result.totalCount})`);

  const from = options.range ? options.range.from : 1;
  const to = options.range ? options.range.to : Math.min(allJobs.length, limit);
  const sliced = allJobs.slice(from - 1, to);

  log('fetch', 'info', `Taking jobs ${from}–${to} out of ${allJobs.length}`);

  const jobs: RawJob[] = sliced.map((item, idx) => {
    const job: RawJob = {
      id: crypto.randomUUID(),
      positionTitle: item.title || 'Unknown Position',
      company: item.companyName || 'Unknown Company',
      location: item.locationRestrictions?.length
        ? item.locationRestrictions.join(', ')
        : 'Remote (Worldwide)',
      applyLink: item.externalUrl || null,
      datePosted: item.pubDate ? item.pubDate.split('T')[0] : null,
      salary: item.salary,
      rawFields: {
        source: 'himalayas',
        himalayasId: item.id,
        categories: item.categories?.join(', ') || '',
        tags: item.tags?.join(', ') || '',
        seniority: item.seniority?.join(', ') || '',
      },
    };

    log('fetch', 'info', `  [${idx + 1}] ${job.company} — ${job.positionTitle}`);
    return job;
  });

  writeStep('step1-raw-jobs', jobs);
  log('fetch', 'info', `Step 1 complete: ${jobs.length} jobs saved (source: Himalayas)`);
  return jobs.length;
}
