import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { log } from '../logger.js';
import { writeStep } from '../store.js';
import type { RawJob } from '../types.js';
import { passesTitleFilter } from './job-filter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GREENHOUSE_SLUGS_PATH = path.join(__dirname, '../../data/greenhouse-slugs.json');

// Greenhouse public job board API — no auth required
const GH_API_BASE = 'https://boards-api.greenhouse.io/v1/boards';

interface GreenhouseSlugEntry {
  slug: string;
  name: string;
}

interface GHLocation {
  name: string;
}

interface GHDepartment {
  name: string;
}

interface GHJob {
  id: number;
  internal_job_id: number;
  title: string;
  updated_at: string;
  absolute_url: string;
  location: GHLocation;
  departments: GHDepartment[];
  content: string; // HTML job description
}

interface GHBoardResponse {
  jobs: GHJob[];
}

function loadGreenhouseSlugs(): GreenhouseSlugEntry[] {
  try {
    const raw = fs.readFileSync(GREENHOUSE_SLUGS_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    log('fetch', 'warn', 'greenhouse-slugs.json not found, using default list');
    return DEFAULT_GREENHOUSE_SLUGS;
  }
}

// Default list of high-value Greenhouse company slugs
const DEFAULT_GREENHOUSE_SLUGS: GreenhouseSlugEntry[] = [
  { slug: 'airbnb', name: 'Airbnb' },
  { slug: 'cloudflare', name: 'Cloudflare' },
  { slug: 'databricks', name: 'Databricks' },
  { slug: 'discord', name: 'Discord' },
  { slug: 'doordash', name: 'DoorDash' },
  { slug: 'figma', name: 'Figma' },
  { slug: 'gitlab', name: 'GitLab' },
  { slug: 'notion', name: 'Notion' },
  { slug: 'openai', name: 'OpenAI' },
  { slug: 'plaid', name: 'Plaid' },
  { slug: 'ramp', name: 'Ramp' },
  { slug: 'reddit', name: 'Reddit' },
  { slug: 'retool', name: 'Retool' },
  { slug: 'rippling', name: 'Rippling' },
  { slug: 'scaleai', name: 'Scale AI' },
  { slug: 'stripe', name: 'Stripe' },
  { slug: 'twosigma', name: 'Two Sigma' },
  { slug: 'vanta', name: 'Vanta' },
  { slug: 'wiz', name: 'Wiz' },
  { slug: 'watershed', name: 'Watershed' },
  { slug: 'abridge', name: 'Abridge' },
  { slug: 'anduril', name: 'Anduril' },
  { slug: 'anthropic', name: 'Anthropic' },
  { slug: 'brex', name: 'Brex' },
  { slug: 'cockroachlabs', name: 'Cockroach Labs' },
  { slug: 'coreweave', name: 'CoreWeave' },
  { slug: 'duolingo', name: 'Duolingo' },
  { slug: 'flexport', name: 'Flexport' },
  { slug: 'gusto', name: 'Gusto' },
  { slug: 'mercury', name: 'Mercury' },
  { slug: 'nuro', name: 'Nuro' },
  { slug: 'pinecone', name: 'Pinecone' },
  { slug: 'posthog', name: 'PostHog' },
  { slug: 'robinhood', name: 'Robinhood' },
  { slug: 'samsara', name: 'Samsara' },
  { slug: 'snyk', name: 'Snyk' },
  { slug: 'toastinc', name: 'Toast' },
  { slug: 'vercel', name: 'Vercel' },
  { slug: 'waymo', name: 'Waymo' },
];

export interface FetchGreenhouseOptions {
  range?: { from: number; to: number };
  limit?: number;
  keywords?: string[];
  excludeKeywords?: string[];
  companySlugs?: string[];
  maxAgeDays?: number;
}

export async function fetchGreenhouse(options: FetchGreenhouseOptions = {}): Promise<number> {
  const allSlugs = loadGreenhouseSlugs();
  const selectedSlugs = options.companySlugs?.length
    ? allSlugs.filter((s) => options.companySlugs!.includes(s.slug))
    : allSlugs;

  const keywords = (options.keywords ?? config.ashbyKeywords ?? []).map((k) => k.toLowerCase());
  const excludeKeywords = (options.excludeKeywords ?? []).map((k) => k.toLowerCase());
  const maxAgeDays = options.maxAgeDays ?? 3;
  const cutoffDate = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);

  log('fetch', 'info', `Fetching Greenhouse jobs for ${selectedSlugs.length} companies...`);
  log('fetch', 'info', `Filters: keywords=${keywords.join(', ') || 'none'}, maxAgeDays=${maxAgeDays}`);

  const collected: Array<{ company: string; slug: string; job: GHJob }> = [];

  for (const { slug, name } of selectedSlugs) {
    const url = `${GH_API_BASE}/${slug}/jobs?content=true`;
    log('fetch', 'info', `  Fetching ${name} (${slug})...`);

    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        log('fetch', 'warn', `  Greenhouse returned ${response.status} for ${slug}`);
        continue;
      }

      const result: GHBoardResponse = await response.json();
      const jobs = result.jobs || [];

      // Filter by recency
      const recent = jobs.filter((j) => {
        const updated = new Date(j.updated_at);
        return updated >= cutoffDate;
      });

      const filtered = recent.filter((j) =>
        passesTitleFilter(
          { title: j.title, department: j.departments.map((d) => d.name).join(' '), location: j.location?.name || null },
          { include: keywords.length ? keywords : undefined, exclude: excludeKeywords.length ? excludeKeywords : undefined }
        )
      );

      log('fetch', 'info', `  ${name}: ${jobs.length} total → ${recent.length} recent → ${filtered.length} matched`);

      for (const job of filtered) {
        collected.push({ company: name, slug, job });
      }
    } catch (err) {
      log('fetch', 'error', `  ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Rate limiting
    await new Promise((r) => setTimeout(r, 300));
  }

  // Sort by updated_at descending
  collected.sort((a, b) => new Date(b.job.updated_at).getTime() - new Date(a.job.updated_at).getTime());

  log('fetch', 'info', `Collected ${collected.length} Greenhouse jobs`);

  const from = options.range ? options.range.from : 1;
  const to = options.range ? options.range.to : Math.min(collected.length, options.limit ?? 30);
  const sliced = collected.slice(from - 1, to);

  log('fetch', 'info', `Taking jobs ${from}–${to} out of ${collected.length} total`);

  const jobs: RawJob[] = sliced.map((entry, idx) => {
    const { company, slug, job: ghJob } = entry;

    const rawJob: RawJob = {
      id: crypto.randomUUID(),
      positionTitle: ghJob.title || 'Unknown Position',
      company,
      location: ghJob.location?.name || null,
      applyLink: ghJob.absolute_url || `https://boards.greenhouse.io/${slug}/jobs/${ghJob.id}`,
      datePosted: ghJob.updated_at ? ghJob.updated_at.split('T')[0] : null,
      salary: null,
      rawFields: {
        source: 'greenhouse',
        greenhouseId: String(ghJob.id),
        greenhouseSlug: slug,
        departments: ghJob.departments?.map((d) => d.name).join(', ') || '',
      },
    };

    log('fetch', 'info', `  [${idx + 1}] ${rawJob.company} — ${rawJob.positionTitle}`);
    return rawJob;
  });

  writeStep('step1-raw-jobs', jobs);
  log('fetch', 'info', `Step 1 complete: ${jobs.length} jobs saved (source: Greenhouse)`);
  return jobs.length;
}
