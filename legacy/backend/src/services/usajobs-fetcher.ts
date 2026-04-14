import crypto from 'node:crypto';
import { config } from '../config.js';
import { log } from '../logger.js';
import { writeStep } from '../store.js';
import type { RawJob } from '../types.js';

// USAJobs API — free, requires Authorization key from data.usajobs.gov/api-request
const USAJOBS_API_URL = 'https://data.usajobs.gov/api/search';

interface USAJobRemuneration {
  MinimumRange: string;
  MaximumRange: string;
  RateIntervalCode: string; // Per Year, Per Hour, etc.
}

interface USAJobItem {
  MatchedObjectId: string;
  MatchedObjectDescriptor: {
    PositionTitle: string;
    OrganizationName: string;
    DepartmentName: string;
    PositionLocationDisplay: string;
    PositionLocation: Array<{ LocationName: string; CityName: string; CountrySubDivisionCode: string }>;
    PositionRemuneration: USAJobRemuneration[];
    PositionURI: string;
    PositionStartDate: string;
    PositionEndDate: string;
    PublicationStartDate: string;
    QualificationSummary: string;
    UserArea: {
      Details: {
        JobCategory: string;
        TeleworkEligible: string;
        TotalOpenings: string;
      };
    };
  };
}

interface USAJobsResponse {
  SearchResult: {
    SearchResultCount: number;
    SearchResultCountAll: number;
    SearchResultItems: USAJobItem[];
  };
}

function formatSalary(remuneration: USAJobRemuneration[]): string | null {
  if (!remuneration?.length) return null;
  const r = remuneration[0];
  const min = parseFloat(r.MinimumRange);
  const max = parseFloat(r.MaximumRange);
  const rate = r.RateIntervalCode === 'Per Year' ? '/yr'
    : r.RateIntervalCode === 'Per Hour' ? '/hr' : '';

  if (min && max) {
    return `$${min.toLocaleString()}–$${max.toLocaleString()}${rate}`;
  }
  if (min) return `$${min.toLocaleString()}${rate}`;
  if (max) return `$${max.toLocaleString()}${rate}`;
  return null;
}

export interface FetchUSAJobsOptions {
  range?: { from: number; to: number };
  limit?: number;
  keyword?: string;
  locationName?: string;
  daysPosted?: number;
  remoteOnly?: boolean;
}

export async function fetchUSAJobs(options: FetchUSAJobsOptions = {}): Promise<number> {
  const apiKey = config.usajobsApiKey;
  const email = config.usajobsEmail;

  if (!apiKey || !email) {
    throw new Error('USAJOBS_API_KEY and USAJOBS_EMAIL must be set in .env');
  }

  const keyword = options.keyword ?? 'software engineer OR data scientist OR machine learning OR robotics OR UI UX developer OR AI ML engineer';
  const daysPosted = options.daysPosted ?? 7;

  log('fetch', 'info', `Fetching jobs from USAJobs API (keyword: "${keyword}")...`);

  const params = new URLSearchParams({
    Keyword: keyword,
    ResultsPerPage: String(options.limit ?? 25),
    DatePosted: String(daysPosted),
    SortField: 'DatePosted',
    SortDirection: 'Desc',
    ...(options.locationName ? { LocationName: options.locationName } : {}),
    ...(options.remoteOnly ? { RemoteIndicator: 'True' } : {}),
  });

  const response = await fetch(`${USAJOBS_API_URL}?${params}`, {
    headers: {
      'Authorization-Key': apiKey,
      'User-Agent': email,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`USAJobs API failed: ${response.status} ${response.statusText}`);
  }

  const result: USAJobsResponse = await response.json();
  const items = result.SearchResult.SearchResultItems || [];

  log('fetch', 'info', `Received ${items.length} jobs from USAJobs (total: ${result.SearchResult.SearchResultCountAll})`);

  const from = options.range ? options.range.from : 1;
  const to = options.range ? options.range.to : items.length;
  const sliced = items.slice(from - 1, to);

  log('fetch', 'info', `Taking jobs ${from}–${to} out of ${items.length}`);

  const jobs: RawJob[] = sliced.map((item, idx) => {
    const d = item.MatchedObjectDescriptor;
    const job: RawJob = {
      id: crypto.randomUUID(),
      positionTitle: d.PositionTitle || 'Unknown Position',
      company: d.OrganizationName || d.DepartmentName || 'U.S. Government',
      location: d.PositionLocationDisplay || null,
      applyLink: d.PositionURI || null,
      datePosted: d.PublicationStartDate ? d.PublicationStartDate.split('T')[0] : null,
      salary: formatSalary(d.PositionRemuneration),
      rawFields: {
        source: 'usajobs',
        usajobsId: item.MatchedObjectId,
        department: d.DepartmentName || '',
        telework: d.UserArea?.Details?.TeleworkEligible || '',
        totalOpenings: d.UserArea?.Details?.TotalOpenings || '',
        qualifications: (d.QualificationSummary || '').slice(0, 500),
      },
    };

    log('fetch', 'info', `  [${idx + 1}] ${job.company} — ${job.positionTitle}`);
    return job;
  });

  writeStep('step1-raw-jobs', jobs);
  log('fetch', 'info', `Step 1 complete: ${jobs.length} jobs saved (source: USAJobs)`);
  return jobs.length;
}
