import crypto from 'node:crypto';
import { config } from '../config.js';
import { log } from '../logger.js';
import { writeStep } from '../store.js';
import type { RawJob } from '../types.js';

const YC_API_URL = 'https://free-y-combinator-jobs-api.p.rapidapi.com/active-jb-7d';

interface YCLocation {
  '@type': string;
  address?: {
    '@type': string;
    addressLocality?: string;
    addressRegion?: string;
    addressCountry?: string;
  };
}

interface YCSalary {
  '@type': string;
  currency?: string;
  value?: {
    '@type': string;
    unitText?: string;
    minValue?: number;
    maxValue?: number;
  };
}

interface YCJob {
  id: string;
  date_posted: string | null;
  title: string;
  organization: string;
  organization_url: string | null;
  locations_raw: YCLocation[] | null;
  locations_derived: string[] | null;
  salary_raw: YCSalary | null;
  employment_type: string[] | null;
  url: string | null;
  remote_derived: boolean | null;
}

function formatSalary(salary: YCSalary | null): string | null {
  if (!salary?.value) return null;
  const { minValue, maxValue, unitText } = salary.value;
  const currency = salary.currency || 'USD';
  const unit = unitText === 'YEAR' ? '/yr' : unitText === 'HOUR' ? '/hr' : '';

  if (minValue && maxValue) {
    return `${currency} $${minValue.toLocaleString()}–$${maxValue.toLocaleString()}${unit}`;
  }
  if (minValue) return `${currency} $${minValue.toLocaleString()}${unit}`;
  if (maxValue) return `${currency} $${maxValue.toLocaleString()}${unit}`;
  return null;
}

function formatLocation(job: YCJob): string | null {
  if (job.locations_derived?.length) {
    return job.locations_derived.join('; ');
  }
  if (job.locations_raw?.length) {
    const addr = job.locations_raw[0]?.address;
    if (addr) {
      const parts = [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(Boolean);
      return parts.join(', ') || null;
    }
  }
  if (job.remote_derived) return 'Remote';
  return null;
}

export async function fetchYC(range?: { from: number; to: number }): Promise<number> {
  if (!config.rapidApiKey) {
    throw new Error('RAPIDAPI_KEY not set. Add it to your .env file.');
  }

  log('fetch', 'info', 'Fetching jobs from Y Combinator API...');

  const response = await fetch(YC_API_URL, {
    headers: {
      'x-rapidapi-host': 'free-y-combinator-jobs-api.p.rapidapi.com',
      'x-rapidapi-key': config.rapidApiKey,
    },
  });

  if (!response.ok) {
    throw new Error(`YC API failed: ${response.status} ${response.statusText}`);
  }

  const data: YCJob[] = await response.json();
  log('fetch', 'info', `Received ${data.length} jobs from YC API`);

  // Sort by date_posted descending (newest first)
  data.sort((a, b) => {
    const da = a.date_posted ? new Date(a.date_posted).getTime() : 0;
    const db = b.date_posted ? new Date(b.date_posted).getTime() : 0;
    return db - da;
  });

  const from = range ? range.from : 1;
  const to = range ? range.to : Math.min(data.length, 10);
  const sliced = data.slice(from - 1, to);
  log('fetch', 'info', `Taking jobs ${from}–${to} (newest first) out of ${data.length} total`);

  const jobs: RawJob[] = sliced.map((item, idx) => {
    const job: RawJob = {
      id: crypto.randomUUID(),
      positionTitle: item.title || 'Unknown Position',
      company: item.organization || 'Unknown Company',
      location: formatLocation(item),
      applyLink: item.url || item.organization_url || null,
      datePosted: item.date_posted ? item.date_posted.split('T')[0] : null,
      salary: formatSalary(item.salary_raw),
      rawFields: {
        source: 'yc',
        ycId: item.id,
        employmentType: item.employment_type?.join(', ') || '',
        remote: String(item.remote_derived ?? ''),
      },
    };

    log('fetch', 'info', `  [${idx + 1}] ${job.company} — ${job.positionTitle}`);
    return job;
  });

  writeStep('step1-raw-jobs', jobs);
  log('fetch', 'info', `Step 1 complete: ${jobs.length} jobs saved (source: YC)`);
  return jobs.length;
}
