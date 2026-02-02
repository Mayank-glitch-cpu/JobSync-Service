import crypto from 'node:crypto';
import { config } from '../config.js';
import { log } from '../logger.js';
import { writeStep } from '../store.js';
import type { RawJob } from '../types.js';

const ASHBY_GQL_URL =
  'https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardWithTeams';

const ASHBY_QUERY = `query ApiJobBoardWithTeams($organizationHostedJobsPageName: String!) {
  jobBoard: jobBoardWithTeams(organizationHostedJobsPageName: $organizationHostedJobsPageName) {
    jobPostings {
      id
      title
      employmentType
      locationName
      compensationTierSummary
      secondaryLocations { locationName }
    }
  }
}`;

/**
 * Curated list of companies that use Ashby as their ATS.
 * slug = the organizationHostedJobsPageName used in jobs.ashbyhq.com/<slug>
 * Add or remove entries as needed.
 */
const ASHBY_COMPANIES: { slug: string; name: string }[] = [
  { slug: 'openai', name: 'OpenAI' },
  { slug: 'deel', name: 'Deel' },
  { slug: 'vanta', name: 'Vanta' },
  { slug: 'notion', name: 'Notion' },
  { slug: 'ramp', name: 'Ramp' },
  { slug: 'cohere', name: 'Cohere' },
  { slug: 'perplexity', name: 'Perplexity' },
  { slug: 'benchling', name: 'Benchling' },
  { slug: 'replit', name: 'Replit' },
  { slug: 'ashby', name: 'Ashby' },
  { slug: 'cursor', name: 'Cursor' },
  { slug: 'cognition', name: 'Cognition' },
  { slug: 'watershed', name: 'Watershed' },
  { slug: 'linear', name: 'Linear' },
  { slug: 'posthog', name: 'PostHog' },
  { slug: 'clerk', name: 'Clerk' },
  { slug: 'runway', name: 'Runway' },
];

interface AshbyJobPosting {
  id: string;
  title: string;
  employmentType: string | null;
  locationName: string | null;
  compensationTierSummary: string | null;
  secondaryLocations: { locationName: string }[];
}

interface AshbyResponse {
  data?: {
    jobBoard?: {
      jobPostings: AshbyJobPosting[];
    };
  };
}

async function fetchCompanyJobs(
  slug: string,
  companyName: string
): Promise<{ company: string; posting: AshbyJobPosting }[]> {
  const response = await fetch(ASHBY_GQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      operationName: 'ApiJobBoardWithTeams',
      variables: { organizationHostedJobsPageName: slug },
      query: ASHBY_QUERY,
    }),
  });

  if (!response.ok) {
    log('fetch', 'warn', `  Ashby API returned ${response.status} for ${slug}`);
    return [];
  }

  const result: AshbyResponse = await response.json();
  const postings = result.data?.jobBoard?.jobPostings ?? [];
  return postings.map((p) => ({ company: companyName, posting: p }));
}

function buildApplyLink(slug: string, jobId: string): string {
  return `https://jobs.ashbyhq.com/${slug}/${jobId}`;
}

function formatLocation(posting: AshbyJobPosting): string | null {
  const locations = [
    posting.locationName,
    ...posting.secondaryLocations.map((s) => s.locationName),
  ].filter(Boolean);
  return locations.length > 0 ? locations.join('; ') : null;
}

export async function fetchTheirStack(range?: {
  from: number;
  to: number;
}): Promise<number> {
  const companies = ASHBY_COMPANIES;

  log(
    'fetch',
    'info',
    `Fetching jobs from ${companies.length} Ashby company boards...`
  );

  const allEntries: { company: string; slug: string; posting: AshbyJobPosting }[] = [];

  for (const { slug, name } of companies) {
    log('fetch', 'info', `  Fetching ${name} (${slug})...`);

    const entries = await fetchCompanyJobs(slug, name);
    if (entries.length > 0) {
      allEntries.push(...entries.map((e) => ({ ...e, slug })));
      log('fetch', 'info', `  ${name}: ${entries.length} jobs`);
    } else {
      log('fetch', 'info', `  ${name}: no jobs found`);
    }

    // Be polite to Ashby's servers
    await new Promise((r) => setTimeout(r, 300));
  }

  log('fetch', 'info', `Received ${allEntries.length} total Ashby jobs`);

  // Apply range
  const from = range ? range.from : 1;
  const to = range ? range.to : Math.min(allEntries.length, config.jobCount);
  const sliced = allEntries.slice(from - 1, to);
  log(
    'fetch',
    'info',
    `Taking jobs ${from}–${to} out of ${allEntries.length} total`
  );

  const jobs: RawJob[] = sliced.map((entry, idx) => {
    const { company, slug, posting } = entry;
    const job: RawJob = {
      id: crypto.randomUUID(),
      positionTitle: posting.title || 'Unknown Position',
      company,
      location: formatLocation(posting),
      applyLink: buildApplyLink(slug, posting.id),
      datePosted: null, // Ashby public API doesn't expose post date
      salary: posting.compensationTierSummary || null,
      rawFields: {
        source: 'ashby',
        ashbyJobId: posting.id,
        ashbySlug: slug,
        employmentType: posting.employmentType || '',
      },
    };

    log(
      'fetch',
      'info',
      `  [${idx + 1}] ${job.company} — ${job.positionTitle}`
    );
    return job;
  });

  writeStep('step1-raw-jobs', jobs);
  log(
    'fetch',
    'info',
    `Step 1 complete: ${jobs.length} jobs saved (source: Ashby)`
  );
  return jobs.length;
}
