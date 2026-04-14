import crypto from 'node:crypto';
import { log } from '../logger.js';
import { writeStep } from '../store.js';
import type { RawJob } from '../types.js';

const REMOTIVE_API_URL = 'https://remotive.com/api/remote-jobs';

// Remotive category slugs relevant to tech/ML/SWE
const CATEGORIES = [
  'software-dev',
  'data',
  'devops',
  'machine-learning',
  'product',
  'qa',
];

interface RemotiveJob {
  id: number;
  url: string;
  title: string;
  company_name: string;
  company_logo_url: string | null;
  category: string;
  tags: string[];
  job_type: string; // full_time, contract, part_time, freelance, internship
  publication_date: string; // ISO date
  candidate_required_location: string;
  salary: string;
  description: string;
}

interface RemotiveResponse {
  'job-count': number;
  jobs: RemotiveJob[];
}

function formatSalary(salary: string | null | undefined): string | null {
  if (!salary || salary.trim() === '') return null;
  return salary.trim();
}

export interface FetchRemotiveOptions {
  range?: { from: number; to: number };
  limit?: number;
  categories?: string[];
  search?: string;
}

export async function fetchRemotive(options: FetchRemotiveOptions = {}): Promise<number> {
  const categories = options.categories ?? CATEGORIES;
  const search = options.search ?? '';

  log('fetch', 'info', `Fetching jobs from Remotive API (categories: ${categories.join(', ')})...`);

  const allJobs: RemotiveJob[] = [];

  for (const category of categories) {
    const params = new URLSearchParams({ category });
    if (search) params.set('search', search);

    const url = `${REMOTIVE_API_URL}?${params}`;
    log('fetch', 'info', `  Fetching category: ${category}...`);

    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        log('fetch', 'warn', `  Remotive API returned ${response.status} for ${category}`);
        continue;
      }

      const result: RemotiveResponse = await response.json();
      log('fetch', 'info', `  ${category}: ${result.jobs.length} jobs`);
      allJobs.push(...result.jobs);
    } catch (err) {
      log('fetch', 'error', `  Failed fetching ${category}: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Small delay between category requests
    await new Promise((r) => setTimeout(r, 300));
  }

  // Dedupe by Remotive ID
  const deduped = Array.from(new Map(allJobs.map((j) => [j.id, j])).values());

  // Sort by publication date descending
  deduped.sort((a, b) => {
    const da = new Date(a.publication_date).getTime() || 0;
    const db = new Date(b.publication_date).getTime() || 0;
    return db - da;
  });

  log('fetch', 'info', `Received ${deduped.length} unique jobs from Remotive`);

  const from = options.range ? options.range.from : 1;
  const to = options.range ? options.range.to : Math.min(deduped.length, options.limit ?? 20);
  const sliced = deduped.slice(from - 1, to);

  log('fetch', 'info', `Taking jobs ${from}–${to} out of ${deduped.length} total`);

  const jobs: RawJob[] = sliced.map((item, idx) => {
    const job: RawJob = {
      id: crypto.randomUUID(),
      positionTitle: item.title || 'Unknown Position',
      company: item.company_name || 'Unknown Company',
      location: item.candidate_required_location || 'Remote',
      applyLink: item.url || null,
      datePosted: item.publication_date ? item.publication_date.split('T')[0] : null,
      salary: formatSalary(item.salary),
      rawFields: {
        source: 'remotive',
        remotiveId: String(item.id),
        category: item.category || '',
        jobType: item.job_type || '',
        tags: item.tags?.join(', ') || '',
      },
    };

    log('fetch', 'info', `  [${idx + 1}] ${job.company} — ${job.positionTitle}`);
    return job;
  });

  writeStep('step1-raw-jobs', jobs);
  log('fetch', 'info', `Step 1 complete: ${jobs.length} jobs saved (source: Remotive)`);
  return jobs.length;
}
