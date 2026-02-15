import crypto from 'node:crypto';
import { config } from '../config.js';
import { log } from '../logger.js';
import { writeStep } from '../store.js';
import type { RawJob } from '../types.js';

// Adzuna API v1 — free tier: 250 requests/month
// Sign up at https://developer.adzuna.com/ for app_id + app_key
const ADZUNA_API_BASE = 'https://api.adzuna.com/v1/api/jobs';

interface AdzunaLocation {
  display_name: string;
  area: string[];
}

interface AdzunaCompany {
  display_name: string;
}

interface AdzunaJob {
  id: string;
  title: string;
  description: string;
  redirect_url: string;
  created: string; // ISO date
  company: AdzunaCompany;
  location: AdzunaLocation;
  salary_min: number | null;
  salary_max: number | null;
  salary_is_predicted: string;
  contract_type: string | null; // permanent, contract
  contract_time: string | null; // full_time, part_time
  category: { tag: string; label: string };
}

interface AdzunaResponse {
  results: AdzunaJob[];
  count: number;
}

function formatSalary(job: AdzunaJob): string | null {
  if (!job.salary_min && !job.salary_max) return null;
  const predicted = job.salary_is_predicted === '1' ? ' (est.)' : '';
  if (job.salary_min && job.salary_max) {
    return `$${Math.round(job.salary_min).toLocaleString()}–$${Math.round(job.salary_max).toLocaleString()}/yr${predicted}`;
  }
  const val = job.salary_min || job.salary_max;
  return `$${Math.round(val!).toLocaleString()}/yr${predicted}`;
}

export interface FetchAdzunaOptions {
  range?: { from: number; to: number };
  limit?: number;
  query?: string;
  country?: string; // 'us', 'gb', 'ca', 'au', etc.
  maxDaysOld?: number;
  fullTime?: boolean;
  salaryMin?: number;
}

export async function fetchAdzuna(options: FetchAdzunaOptions = {}): Promise<number> {
  const appId = config.adzunaAppId;
  const appKey = config.adzunaAppKey;

  if (!appId || !appKey) {
    throw new Error('ADZUNA_APP_ID and ADZUNA_APP_KEY must be set in .env');
  }

  const country = options.country ?? 'us';
  const query = options.query ?? 'software engineer OR machine learning engineer';
  const maxDaysOld = options.maxDaysOld ?? 3;
  const numPages = Math.ceil((options.limit ?? 20) / 50); // Adzuna returns up to 50/page

  log('fetch', 'info', `Fetching jobs from Adzuna API (country: ${country}, query: "${query}")...`);

  const allJobs: AdzunaJob[] = [];

  for (let page = 1; page <= numPages; page++) {
    const params = new URLSearchParams({
      app_id: appId,
      app_key: appKey,
      what: query,
      results_per_page: '50',
      max_days_old: String(maxDaysOld),
      sort_by: 'date',
      ...(options.fullTime !== false ? { full_time: '1' } : {}),
      ...(options.salaryMin ? { salary_min: String(options.salaryMin) } : {}),
    });

    const url = `${ADZUNA_API_BASE}/${country}/search/${page}?${params}`;
    log('fetch', 'info', `  Fetching page ${page}/${numPages}...`);

    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        log('fetch', 'warn', `  Adzuna API returned ${response.status} on page ${page}`);
        break;
      }

      const result: AdzunaResponse = await response.json();
      if (result.results?.length) {
        allJobs.push(...result.results);
      } else {
        break; // No more results
      }
    } catch (err) {
      log('fetch', 'error', `  Page ${page} failed: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }

    // Rate limiting
    if (page < numPages) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  log('fetch', 'info', `Received ${allJobs.length} jobs from Adzuna`);

  const from = options.range ? options.range.from : 1;
  const to = options.range ? options.range.to : Math.min(allJobs.length, options.limit ?? 20);
  const sliced = allJobs.slice(from - 1, to);

  log('fetch', 'info', `Taking jobs ${from}–${to} out of ${allJobs.length} total`);

  const jobs: RawJob[] = sliced.map((item, idx) => {
    const job: RawJob = {
      id: crypto.randomUUID(),
      positionTitle: item.title || 'Unknown Position',
      company: item.company?.display_name || 'Unknown Company',
      location: item.location?.display_name || null,
      applyLink: item.redirect_url || null,
      datePosted: item.created ? item.created.split('T')[0] : null,
      salary: formatSalary(item),
      rawFields: {
        source: 'adzuna',
        adzunaId: item.id,
        category: item.category?.label || '',
        contractType: item.contract_type || '',
        contractTime: item.contract_time || '',
        country,
      },
    };

    log('fetch', 'info', `  [${idx + 1}] ${job.company} — ${job.positionTitle}`);
    return job;
  });

  writeStep('step1-raw-jobs', jobs);
  log('fetch', 'info', `Step 1 complete: ${jobs.length} jobs saved (source: Adzuna)`);
  return jobs.length;
}
