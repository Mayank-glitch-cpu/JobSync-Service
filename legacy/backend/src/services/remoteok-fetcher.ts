import crypto from 'node:crypto';
import { log } from '../logger.js';
import { writeStep } from '../store.js';
import type { RawJob } from '../types.js';

const REMOTEOK_API_URL = 'https://remoteok.com/api';

interface RemoteOKJob {
  id: string;
  epoch: string; // unix timestamp
  date: string; // ISO date
  company: string;
  company_logo: string | null;
  position: string;
  tags: string[];
  description: string;
  location: string;
  salary_min: number | null;
  salary_max: number | null;
  url: string;
  apply_url: string | null;
}

function formatSalary(job: RemoteOKJob): string | null {
  if (!job.salary_min && !job.salary_max) return null;
  if (job.salary_min && job.salary_max) {
    return `USD $${job.salary_min.toLocaleString()}–$${job.salary_max.toLocaleString()}/yr`;
  }
  const val = job.salary_min || job.salary_max;
  return `USD $${val!.toLocaleString()}/yr`;
}

export interface FetchRemoteOKOptions {
  range?: { from: number; to: number };
  limit?: number;
  tags?: string[];
}

export async function fetchRemoteOK(options: FetchRemoteOKOptions = {}): Promise<number> {
  log('fetch', 'info', 'Fetching jobs from RemoteOK API...');

  const response = await fetch(REMOTEOK_API_URL, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'JobSync-Service/1.0',
    },
  });

  if (!response.ok) {
    throw new Error(`RemoteOK API failed: ${response.status} ${response.statusText}`);
  }

  // RemoteOK returns an array where [0] is a legal notice, rest are jobs
  const raw: unknown[] = await response.json();
  const allJobs = raw.slice(1) as RemoteOKJob[];

  log('fetch', 'info', `Received ${allJobs.length} jobs from RemoteOK`);

  // Optional tag filtering
  const filterTags = (options.tags ?? []).map((t) => t.toLowerCase());
  const filtered = filterTags.length > 0
    ? allJobs.filter((job) =>
        job.tags?.some((tag) => filterTags.some((ft) => tag.toLowerCase().includes(ft)))
      )
    : allJobs;

  log('fetch', 'info', `${filtered.length} jobs after tag filter`);

  // Already sorted by most recent from the API
  const from = options.range ? options.range.from : 1;
  const to = options.range ? options.range.to : Math.min(filtered.length, options.limit ?? 20);
  const sliced = filtered.slice(from - 1, to);

  log('fetch', 'info', `Taking jobs ${from}–${to} out of ${filtered.length} total`);

  const jobs: RawJob[] = sliced.map((item, idx) => {
    const job: RawJob = {
      id: crypto.randomUUID(),
      positionTitle: item.position || 'Unknown Position',
      company: item.company || 'Unknown Company',
      location: item.location || 'Remote',
      applyLink: item.apply_url || item.url || null,
      datePosted: item.date ? item.date.split('T')[0] : null,
      salary: formatSalary(item),
      rawFields: {
        source: 'remoteok',
        remoteokId: item.id,
        tags: item.tags?.join(', ') || '',
      },
    };

    log('fetch', 'info', `  [${idx + 1}] ${job.company} — ${job.positionTitle}`);
    return job;
  });

  writeStep('step1-raw-jobs', jobs);
  log('fetch', 'info', `Step 1 complete: ${jobs.length} jobs saved (source: RemoteOK)`);
  return jobs.length;
}
