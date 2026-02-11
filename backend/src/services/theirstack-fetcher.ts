import crypto from 'node:crypto';
import { config } from '../config.js';
import { log } from '../logger.js';
import { writeStep } from '../store.js';
import type { RawJob } from '../types.js';

const ASHBY_PUBLIC_API_BASE = 'https://api.ashbyhq.com/posting-api/job-board';

/**
 * Curated list of companies that use Ashby as their ATS.
 * slug = jobs.ashbyhq.com/<slug>
 */
const ASHBY_COMPANY_SLUGS: string[] = [
  'airtable', 'alan', 'altura', 'away', 'deliveroo', 'duolingo', 'flock-safety', 'hackerone',
  'notion', 'opendoor', 'oyster', 'posthog', 'ramp', 'sequoia', 'sony', 'vanta', 'cursor',
  'deel', 'harvey', 'modern-treasury', 'openai', 'reddit', 'shopify', 'snowflake', 'apify',
  'ashby', 'buffer', 'factory', 'hcompany', 'jerry.ai', 'lightning', 'linear', 'lottie',
  'lovable', 'notable', 'scribd', 'searchable', 'silver', 'tapcheck', 'blueberrypediatrics',
  'cambly', 'checkly', 'cleric', 'continua', 'dryft', 'duck-duck-go', 'equals', 'firetiger',
  'homevision', 'imprint', 'kombo', 'legionhealth', 'livekit', 'matterworks', 'meticulous',
  'modal', 'norm-ai', 'office-hours', 'ontic', 'orb', 'parabola-io', 'pear', 'pear-vc',
  'permitflow', 'sentilink', 'sfcompute', 'steel', 'tiplink', 'titan', 'turnstile',
  'verge-genomics', 'virtahealth', 'vitalize', 'wirescreen', '15five', '6sense', 'aave',
  'ada', 'adept', 'affinity', 'affirm', 'agora', 'ai21-labs', 'airbyte', 'alchemy', 'alloy',
  'alma', 'amplitude', 'anaplan', 'anduril', 'angellist', 'anthropic', 'anyscale', 'apollo',
  'applied-intuition', 'asana', 'assembly-ai', 'attio', 'aurora', 'baseten', 'benchling',
  'braze', 'brex', 'canva', 'carta', 'chainalysis', 'character-ai', 'chime', 'circle',
  'clerk', 'clickhouse', 'clockwise', 'coda', 'codeium', 'cohere', 'coinbase', 'contentful',
  'courier', 'databricks', 'datadog', 'dbt-labs', 'deepgram', 'discord', 'docker', 'doordash',
  'drata', 'figma', 'fireblocks', 'fivetran', 'fly', 'framer', 'front', 'gong', 'grafana-labs',
  'grammarly', 'gusto', 'hashicorp', 'hightouch', 'hubspot', 'huggingface', 'instacart',
  'intercom', 'ironclad', 'iterable', 'jasper', 'kraken', 'labelbox', 'launchdarkly',
  'lemonade', 'loom', 'lyra-health', 'marqeta', 'materialize', 'mercury', 'metabase', 'miro',
  'mistral', 'modal-labs', 'monday', 'navan', 'neon', 'newrelic', 'novu', 'nuro', 'opensea',
  'oura', 'outreach', 'paddle', 'pandadoc', 'paxos', 'pendo', 'perplexity', 'personio',
  'pinecone', 'plaid', 'planetscale', 'postman', 'prefect', 'productboard', 'pulley', 'pulumi',
  'qdrant', 'railway', 'raycast', 'readme', 'remote', 'render', 'replicate', 'replit',
  'resend', 'retool', 'rippling', 'root-insurance', 'runway', 'samsara', 'sanity', 'sardine',
  'scale', 'secureframe', 'sentry', 'shield-ai', 'singlestore', 'skydio', 'slack', 'smartcar',
  'snorkel', 'snyk', 'sourcegraph', 'spotify', 'spring-health', 'stability-ai', 'stainless',
  'statsig', 'storyblok', 'stripe', 'stytch', 'substack', 'supabase', 'synthesia', 'tailscale',
  'temporal', 'tenstorrent', 'thirdweb', 'timescale', 'toast', 'together', 'together-ai',
  'trm-labs', 'twilio', 'uniswap', 'upstart', 'vapi', 'vercel', 'verkada', 'voiceflow',
  'wandb', 'warp', 'watershed', 'weaviate', 'webflow', 'weights-biases', 'whimsical', 'whoop',
  'writer', 'xata', 'yugabyte', 'zed', 'zip', 'zipline', 'zora', 'zuora'
];

interface AshbyLocation {
  location?: string;
  locationName?: string;
}

interface AshbyCompensation {
  summary?: string;
}

interface AshbyJobPosting {
  id: string;
  title?: string;
  applyUrl?: string;
  location?: AshbyLocation | string | null;
  department?: string | null;
  team?: string | null;
  descriptionPlain?: string | null;
  publishedAt?: string | null;
  compensation?: AshbyCompensation | null;
}

interface AshbyPublicResponse {
  jobs?: AshbyJobPosting[];
}

interface CompanyPosting {
  company: string;
  slug: string;
  posting: AshbyJobPosting;
}

export interface FetchAshbyOptions {
  range?: { from: number; to: number };
  limit?: number;
  keywords?: string[];
  companySlugs?: string[];
  publishedWithinHours?: number;
  postedTodayOnly?: boolean;
}

function normalizeText(value: string | null | undefined): string {
  return (value || '').trim().toLowerCase();
}

function normalizeKeywords(input?: string[]): string[] {
  if (!input || input.length === 0) {
    return config.ashbyKeywords;
  }

  return input
    .map((keyword) => keyword.trim().toLowerCase())
    .filter(Boolean);
}

function hasKeywordMatch(posting: AshbyJobPosting, keywords: string[]): boolean {
  if (keywords.length === 0) {
    return true;
  }

  const haystack = [posting.title, posting.department, posting.team, posting.descriptionPlain]
    .map((field) => normalizeText(field))
    .join(' ');

  return keywords.some((keyword) => haystack.includes(keyword));
}

function isPublishedTodayUTC(publishedAt: string | null | undefined): boolean {
  if (!publishedAt) {
    return false;
  }

  const publishedDate = new Date(publishedAt);
  if (Number.isNaN(publishedDate.getTime())) {
    return false;
  }

  const now = new Date();
  return (
    publishedDate.getUTCFullYear() === now.getUTCFullYear() &&
    publishedDate.getUTCMonth() === now.getUTCMonth() &&
    publishedDate.getUTCDate() === now.getUTCDate()
  );
}

function isWithinLookback(
  publishedAt: string | null | undefined,
  lookbackHours: number
): boolean {
  if (!publishedAt) {
    return false;
  }

  const publishedTime = Date.parse(publishedAt);
  if (Number.isNaN(publishedTime)) {
    return false;
  }

  if (lookbackHours <= 0) {
    return true;
  }

  const cutoff = Date.now() - lookbackHours * 60 * 60 * 1000;
  return publishedTime >= cutoff;
}

function extractLocation(location: AshbyJobPosting['location']): string | null {
  if (!location) {
    return null;
  }

  if (typeof location === 'string') {
    return location === '' ? null : location;
  }

  return location.locationName || location.location || null;
}

function slugToCompanyName(slug: string): string {
  return slug
    .split(/[.-]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function resolveCompanies(selectedSlugs?: string[]): { slug: string; name: string }[] {
  const allCompanies = ASHBY_COMPANY_SLUGS.map((slug) => ({ slug, name: slugToCompanyName(slug) }));

  if (!selectedSlugs || selectedSlugs.length === 0) {
    return allCompanies;
  }

  const selectedSet = new Set(selectedSlugs.map((slug) => slug.trim().toLowerCase()));
  return allCompanies.filter((company) => selectedSet.has(company.slug.toLowerCase()));
}

async function fetchCompanyJobs(
  slug: string,
  companyName: string,
  includeCompensation: boolean
): Promise<CompanyPosting[]> {
  const url = new URL(`${ASHBY_PUBLIC_API_BASE}/${slug}`);
  if (includeCompensation) {
    url.searchParams.set('includeCompensation', 'true');
  }

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'User-Agent': 'JobSync-Service/1.0',
    },
  });

  if (!response.ok) {
    log('fetch', 'warn', `  Ashby API returned ${response.status} for ${slug}`);
    return [];
  }

  try {
    const result: AshbyPublicResponse = await response.json();
    const postings = result.jobs ?? [];
    return postings.map((posting) => ({ company: companyName, slug, posting }));
  } catch (error) {
    log('fetch', 'error', `  Failed to parse JSON for ${slug} (status ${response.status}): ${error}`);
    return [];
  }
}

function toRawJob(entry: CompanyPosting): RawJob {
  const { company, slug, posting } = entry;

  return {
    id: crypto.randomUUID(),
    positionTitle: posting.title?.trim() || 'Unknown Position',
    company,
    location: extractLocation(posting.location),
    applyLink: posting.applyUrl || `https://jobs.ashbyhq.com/${slug}/${posting.id}`,
    datePosted: posting.publishedAt || null,
    salary: posting.compensation?.summary || null,
    rawFields: {
      source: 'ashby-posting-api',
      ashbyJobId: posting.id,
      ashbySlug: slug,
      department: posting.department || '',
      team: posting.team || '',
    },
  };
}

export async function fetchTheirStack(options: FetchAshbyOptions = {}): Promise<number> {
  const companies = resolveCompanies(options.companySlugs);
  const keywords = normalizeKeywords(options.keywords);
  const lookbackHours = options.publishedWithinHours ?? config.ashbyPublishedWithinHours;
  const postedTodayOnly = options.postedTodayOnly || false;

  log('fetch', 'info', `Fetching Ashby data for ${companies.length} selected companies...`);
  log(
    'fetch',
    'info',
    `Filters: keywords=${keywords.join(', ') || 'none'}, postedTodayOnly=${postedTodayOnly}, publishedWithinHours=${lookbackHours}`
  );

  const collected: CompanyPosting[] = [];

  for (const { slug, name } of companies) {
    log('fetch', 'info', `  Fetching ${name} (${slug})...`);

    const entries = await fetchCompanyJobs(slug, name, config.ashbyIncludeCompensation);
    log('fetch', 'info', `  ${name}: ${entries.length} jobs returned by Ashby`);

    const filteredByKeyword = entries.filter(({ posting }) => hasKeywordMatch(posting, keywords));
    const filteredByDate = filteredByKeyword.filter(({ posting }) =>
      postedTodayOnly
        ? isPublishedTodayUTC(posting.publishedAt)
        : isWithinLookback(posting.publishedAt, lookbackHours)
    );

    log('fetch', 'info', `  ${name}: ${filteredByDate.length} jobs after filters`);

    collected.push(...filteredByDate);

    if (config.ashbyRequestDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, config.ashbyRequestDelayMs));
    }
  }

  const deduped = Array.from(new Map(collected.map((item) => [item.posting.id, item])).values())
    .sort((a, b) => {
      const aTime = Date.parse(a.posting.publishedAt || '') || 0;
      const bTime = Date.parse(b.posting.publishedAt || '') || 0;
      return bTime - aTime;
    });

  log('fetch', 'info', `Collected ${deduped.length} filtered Ashby jobs`);

  const from = options.range ? options.range.from : 1;
  const to = options.range
    ? options.range.to
    : Math.min(deduped.length, options.limit ?? config.jobCount);
  const sliced = deduped.slice(Math.max(0, from - 1), Math.max(0, to));

  log('fetch', 'info', `Taking jobs ${from}–${to} out of ${deduped.length} total`);

  const jobs: RawJob[] = sliced.map((entry, index) => {
    const job = toRawJob(entry);
    log('fetch', 'info', `  [${index + 1}] ${job.company} — ${job.positionTitle}`);
    return job;
  });

  writeStep('step1-raw-jobs', jobs);
  log('fetch', 'info', `Step 1 complete: ${jobs.length} jobs saved (source: Ashby)`);

  return jobs.length;
}
