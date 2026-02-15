import crypto from 'node:crypto';
import { config } from '../config.js';
import { log } from '../logger.js';
import { writeStep } from '../store.js';
import type { RawJob } from '../types.js';

// LinkedIn Jobs API via RapidAPI — requires RAPIDAPI_KEY
// Uses "LinkedIn Jobs Search" by jaypat87 or similar provider
const LINKEDIN_API_URL = 'https://linkedin-jobs-search.p.rapidapi.com/';

interface LinkedInJob {
  id: string;
  title: string;
  company_name: string;
  company_url: string | null;
  job_url: string;
  location: string;
  posted_date: string;
  job_type: string | null; // Full-time, Contract, etc.
  salary: string | null;
  benefits: string | null;
  experience_level: string | null;
}

export interface FetchLinkedInOptions {
  range?: { from: number; to: number };
  limit?: number;
  keywords?: string;
  locationId?: string;
  datePosted?: 'pastDay' | 'pastWeek' | 'pastMonth';
  experienceLevel?: 'entry' | 'mid' | 'senior';
  jobType?: 'full-time' | 'contract' | 'part-time' | 'internship';
  remoteFilter?: 'remote' | 'on-site' | 'hybrid';
}

export async function fetchLinkedIn(options: FetchLinkedInOptions = {}): Promise<number> {
  if (!config.rapidApiKey) {
    throw new Error('RAPIDAPI_KEY not set. Add it to your .env file.');
  }

  const keywords = options.keywords ?? 'software engineer OR machine learning engineer';
  const datePosted = options.datePosted ?? 'pastWeek';

  log('fetch', 'info', `Fetching jobs from LinkedIn API (keywords: "${keywords}")...`);

  const body: Record<string, unknown> = {
    search_terms: keywords,
    location: 'United States',
    page: '1',
    fetch_full_text: 'yes',
    ...(options.datePosted ? { date_posted: datePosted } : {}),
    ...(options.experienceLevel ? { experience_level: options.experienceLevel } : {}),
    ...(options.jobType ? { employment_type: options.jobType } : {}),
    ...(options.remoteFilter ? { remote: options.remoteFilter } : {}),
  };

  const response = await fetch(LINKEDIN_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-rapidapi-host': 'linkedin-jobs-search.p.rapidapi.com',
      'x-rapidapi-key': config.rapidApiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`LinkedIn API failed: ${response.status} ${response.statusText}`);
  }

  const data: LinkedInJob[] = await response.json();
  log('fetch', 'info', `Received ${data.length} jobs from LinkedIn API`);

  const from = options.range ? options.range.from : 1;
  const to = options.range ? options.range.to : Math.min(data.length, options.limit ?? 20);
  const sliced = data.slice(from - 1, to);

  log('fetch', 'info', `Taking jobs ${from}–${to} out of ${data.length} total`);

  const jobs: RawJob[] = sliced.map((item, idx) => {
    const job: RawJob = {
      id: crypto.randomUUID(),
      positionTitle: item.title || 'Unknown Position',
      company: item.company_name || 'Unknown Company',
      location: item.location || null,
      applyLink: item.job_url || null,
      datePosted: item.posted_date ? item.posted_date.split('T')[0] : null,
      salary: item.salary || null,
      rawFields: {
        source: 'linkedin',
        linkedinId: item.id || '',
        jobType: item.job_type || '',
        experienceLevel: item.experience_level || '',
      },
    };

    log('fetch', 'info', `  [${idx + 1}] ${job.company} — ${job.positionTitle}`);
    return job;
  });

  writeStep('step1-raw-jobs', jobs);
  log('fetch', 'info', `Step 1 complete: ${jobs.length} jobs saved (source: LinkedIn)`);
  return jobs.length;
}
