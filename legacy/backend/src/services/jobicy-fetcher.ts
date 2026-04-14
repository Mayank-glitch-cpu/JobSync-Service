import crypto from 'node:crypto';
import { log } from '../logger.js';
import { writeStep } from '../store.js';
import type { RawJob } from '../types.js';

// Jobicy — free public RSS/JSON API for remote jobs
const JOBICY_API_URL = 'https://jobicy.com/api/v2/remote-jobs';

interface JobicyJob {
  id: number;
  url: string;
  jobTitle: string;
  companyName: string;
  companyLogo: string;
  jobIndustry: string[];
  jobType: string[];
  jobGeo: string;
  jobLevel: string;
  jobExcerpt: string;
  pubDate: string;
  annualSalaryMin: number | null;
  annualSalaryMax: number | null;
  salaryCurrency: string | null;
}

interface JobicyResponse {
  apiVersion: string;
  documentationUrl: string;
  friendlyMessage: string;
  jobCount: number;
  xpiresAt: string;
  jobs: JobicyJob[];
}

function formatSalary(job: JobicyJob): string | null {
  if (!job.annualSalaryMin && !job.annualSalaryMax) return null;
  const currency = job.salaryCurrency || 'USD';
  if (job.annualSalaryMin && job.annualSalaryMax) {
    return `${currency} $${job.annualSalaryMin.toLocaleString()}–$${job.annualSalaryMax.toLocaleString()}/yr`;
  }
  const val = job.annualSalaryMin || job.annualSalaryMax;
  return `${currency} $${val!.toLocaleString()}/yr`;
}

export interface FetchJobicyOptions {
  range?: { from: number; to: number };
  limit?: number;
  count?: number; // API param: number of jobs to request (max 50)
  geo?: string; // Country filter: 'usa', 'uk', etc.
  industry?: string; // 'tech', 'marketing', etc.
  tag?: string; // Keyword tag
}

export async function fetchJobicy(options: FetchJobicyOptions = {}): Promise<number> {
  const count = options.count ?? 50;
  const geo = options.geo ?? 'usa';
  const tag = options.tag ?? 'software-engineer';

  log('fetch', 'info', `Fetching jobs from Jobicy API (geo: ${geo}, tag: ${tag})...`);

  const params = new URLSearchParams({
    count: String(count),
    geo,
    ...(options.industry ? { industry: options.industry } : {}),
    ...(options.tag ? { tag: options.tag } : {}),
  });

  const url = `${JOBICY_API_URL}?${params}`;

  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`Jobicy API failed: ${response.status} ${response.statusText}`);
  }

  const result: JobicyResponse = await response.json();
  const allJobs = result.jobs || [];

  log('fetch', 'info', `Received ${allJobs.length} jobs from Jobicy (count: ${result.jobCount})`);

  const from = options.range ? options.range.from : 1;
  const to = options.range ? options.range.to : Math.min(allJobs.length, options.limit ?? 20);
  const sliced = allJobs.slice(from - 1, to);

  log('fetch', 'info', `Taking jobs ${from}–${to} out of ${allJobs.length} total`);

  const jobs: RawJob[] = sliced.map((item, idx) => {
    const job: RawJob = {
      id: crypto.randomUUID(),
      positionTitle: item.jobTitle || 'Unknown Position',
      company: item.companyName || 'Unknown Company',
      location: item.jobGeo || 'Remote',
      applyLink: item.url || null,
      datePosted: item.pubDate ? item.pubDate.split('T')[0] : null,
      salary: formatSalary(item),
      rawFields: {
        source: 'jobicy',
        jobicyId: String(item.id),
        industry: item.jobIndustry?.join(', ') || '',
        jobType: item.jobType?.join(', ') || '',
        jobLevel: item.jobLevel || '',
        geo,
      },
    };

    log('fetch', 'info', `  [${idx + 1}] ${job.company} — ${job.positionTitle}`);
    return job;
  });

  writeStep('step1-raw-jobs', jobs);
  log('fetch', 'info', `Step 1 complete: ${jobs.length} jobs saved (source: Jobicy)`);
  return jobs.length;
}
