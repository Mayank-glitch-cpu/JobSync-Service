import crypto from 'node:crypto';
import { config } from '../config.js';
import { log } from '../logger.js';
import { writeStep } from '../store.js';
import type { RawJob } from '../types.js';

const JSEARCH_API_URL = 'https://jsearch.p.rapidapi.com/search';

interface JSearchJob {
  job_id: string;
  employer_name: string;
  job_title: string;
  job_apply_link: string | null;
  job_description: string | null;
  job_location: string | null;
  job_city: string | null;
  job_state: string | null;
  job_country: string | null;
  job_is_remote: boolean;
  job_employment_type_text: string | null;
  job_posted_at_datetime_utc: string | null;
  job_min_salary: number | null;
  job_max_salary: number | null;
  job_salary_currency: string | null;
  job_salary_period: string | null;
}

interface JSearchResponse {
  status: string;
  data: JSearchJob[];
}

function formatSalary(job: JSearchJob): string | null {
  if (!job.job_min_salary && !job.job_max_salary) return null;
  const currency = job.job_salary_currency || 'USD';
  const period = job.job_salary_period === 'HOUR' ? '/hr' :
                 job.job_salary_period === 'YEAR' ? '/yr' :
                 job.job_salary_period === 'MONTH' ? '/mo' : '';
  if (job.job_min_salary && job.job_max_salary) {
    return `${currency} $${job.job_min_salary.toLocaleString()}–$${job.job_max_salary.toLocaleString()}${period}`;
  }
  const val = job.job_min_salary || job.job_max_salary;
  return `${currency} $${val!.toLocaleString()}${period}`;
}

function formatLocation(job: JSearchJob): string | null {
  if (job.job_is_remote) return 'Remote';
  if (job.job_location) return job.job_location;
  const parts = [job.job_city, job.job_state, job.job_country].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

export async function fetchJSearch(range?: { from: number; to: number }): Promise<number> {
  if (!config.rapidApiKey) {
    throw new Error('RAPIDAPI_KEY not set. Add it to your .env file.');
  }

  const query = config.jsearchQuery;
  const numPages = config.jsearchNumPages;

  log('fetch', 'info', `Fetching jobs from JSearch API (query: "${query}", pages: ${numPages})...`);

  const allJobs: JSearchJob[] = [];

  for (let page = 1; page <= numPages; page++) {
    const params = new URLSearchParams({
      query,
      page: String(page),
      num_pages: '1',
      country: 'us',
      date_posted: 'today',
    });

    log('fetch', 'info', `  Fetching page ${page}/${numPages}...`);

    const response = await fetch(`${JSEARCH_API_URL}?${params}`, {
      headers: {
        'x-rapidapi-host': 'jsearch.p.rapidapi.com',
        'x-rapidapi-key': config.rapidApiKey,
      },
    });

    if (!response.ok) {
      throw new Error(`JSearch API failed: ${response.status} ${response.statusText}`);
    }

    const result: JSearchResponse = await response.json();
    if (result.data?.length) {
      allJobs.push(...result.data);
    }

    // Rate limiting between pages
    if (page < numPages) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  log('fetch', 'info', `Received ${allJobs.length} jobs from JSearch API`);

  // Already sorted by relevance/recency from API
  const from = range ? range.from : 1;
  const to = range ? range.to : Math.min(allJobs.length, 10);
  const sliced = allJobs.slice(from - 1, to);
  log('fetch', 'info', `Taking jobs ${from}–${to} out of ${allJobs.length} total`);

  const jobs: RawJob[] = sliced.map((item, idx) => {
    const job: RawJob = {
      id: crypto.randomUUID(),
      positionTitle: item.job_title || 'Unknown Position',
      company: item.employer_name || 'Unknown Company',
      location: formatLocation(item),
      applyLink: item.job_apply_link,
      datePosted: item.job_posted_at_datetime_utc?.split('T')[0] || null,
      salary: formatSalary(item),
      rawFields: {
        source: 'jsearch',
        jsearchId: item.job_id,
        employmentType: item.job_employment_type_text || '',
        remote: String(item.job_is_remote ?? ''),
      },
    };

    log('fetch', 'info', `  [${idx + 1}] ${job.company} — ${job.positionTitle}`);
    return job;
  });

  writeStep('step1-raw-jobs', jobs);
  log('fetch', 'info', `Step 1 complete: ${jobs.length} jobs saved (source: JSearch)`);
  return jobs.length;
}
