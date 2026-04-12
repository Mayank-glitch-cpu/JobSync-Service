import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../logger.js';
import { writeStep } from '../store.js';
import type { RawJob } from '../types.js';
import { passesTitleFilter } from './job-filter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SLUGS_PATH = path.join(__dirname, '../../data/workable-slugs.json');

// Workable public job board API — no auth required
// Endpoint: GET https://apply.workable.com/api/v1/widget/accounts/{subdomain}
// Returns job listings for a company's public board.

interface WorkableJob {
  id: string;
  title: string;
  shortcode: string;
  department: string | null;
  url: string;
  application_url: string;
  shortlink: string;
  location: {
    location_str: string;
    city: string | null;
    region: string | null;
    country: string | null;
    country_code: string | null;
    telecommuting: boolean;
  };
  created_at: string; // ISO date
}

interface WorkableWidgetResponse {
  jobs: WorkableJob[];
  name: string;
  about: string;
}

interface SlugEntry {
  subdomain: string;
  name: string;
}

const DEFAULT_SLUGS: SlugEntry[] = [
  { subdomain: 'synthesia', name: 'Synthesia' },
  { subdomain: 'sentry-2', name: 'Sentry' },
  { subdomain: 'anyscale', name: 'Anyscale' },
  { subdomain: 'typeform', name: 'Typeform' },
  { subdomain: 'deel-1', name: 'Deel' },
  { subdomain: 'pleo', name: 'Pleo' },
  { subdomain: 'contentful', name: 'Contentful' },
  { subdomain: 'deepmind', name: 'DeepMind' },
  { subdomain: 'cloudinary', name: 'Cloudinary' },
  { subdomain: 'revolut', name: 'Revolut' },
  { subdomain: 'monzo', name: 'Monzo' },
  { subdomain: 'numbrs', name: 'Numbrs' },
  { subdomain: 'prima', name: 'Prima' },
  { subdomain: 'taxfix', name: 'Taxfix' },
  { subdomain: 'lemonade', name: 'Lemonade' },
  { subdomain: 'onfido', name: 'Onfido' },
  { subdomain: 'wikimedia', name: 'Wikimedia' },
  { subdomain: 'cure-53', name: 'Cure53' },
  { subdomain: 'figment', name: 'Figment' },
  { subdomain: 'phantom', name: 'Phantom' },
];

function loadSlugs(): SlugEntry[] {
  try {
    const raw = fs.readFileSync(SLUGS_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return DEFAULT_SLUGS;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Main Export ────────────────────────────────────────────────────────

export interface FetchWorkableOptions {
  range?: { from: number; to: number };
  limit?: number;
  /** Specific company subdomains. Uses all from slugs file if empty. */
  subdomains?: string[];
  /** Title keyword filter. */
  keywords?: string[];
  /** Exclude titles matching these keywords. */
  excludeKeywords?: string[];
  /** Only include postings created within this many days. Default: 7. */
  maxAgeDays?: number;
}

export async function fetchWorkable(options: FetchWorkableOptions = {}): Promise<number> {
  const allSlugs = loadSlugs();
  const selectedSlugs = options.subdomains?.length
    ? allSlugs.filter((s) =>
        options.subdomains!.some((sd) => sd.toLowerCase() === s.subdomain.toLowerCase())
      )
    : allSlugs;

  const keywords = (options.keywords ?? []).map((k) => k.toLowerCase());
  const excludeKeywords = (options.excludeKeywords ?? []).map((k) => k.toLowerCase());
  const maxAgeDays = options.maxAgeDays ?? 7;
  const cutoffDate = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);

  log('fetch', 'info', `Fetching Workable jobs for ${selectedSlugs.length} companies...`);

  const collected: Array<{ companyName: string; subdomain: string; job: WorkableJob }> = [];

  for (const { subdomain, name } of selectedSlugs) {
    const url = `https://apply.workable.com/api/v1/widget/accounts/${subdomain}`;
    log('fetch', 'info', `  Fetching ${name} (${subdomain})...`);

    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        log('fetch', 'warn', `    Workable returned ${response.status} for ${subdomain}`);
        continue;
      }

      const result: WorkableWidgetResponse = await response.json();
      const jobs = result.jobs || [];

      // Date filter
      const recent = jobs.filter((j) => {
        if (!j.created_at) return true;
        const created = new Date(j.created_at);
        return !Number.isNaN(created.getTime()) && created >= cutoffDate;
      });

      const filtered = recent.filter((j) =>
        passesTitleFilter(
          { title: j.title },
          { include: keywords.length ? keywords : undefined, exclude: excludeKeywords.length ? excludeKeywords : undefined }
        )
      );

      log('fetch', 'info', `    ${name}: ${jobs.length} total → ${recent.length} recent → ${filtered.length} matched`);

      for (const job of filtered) {
        collected.push({ companyName: result.name || name, subdomain, job });
      }
    } catch (err) {
      log('fetch', 'error', `    ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    await sleep(400);
  }

  // Sort by created_at descending
  collected.sort((a, b) => {
    const aTime = a.job.created_at ? new Date(a.job.created_at).getTime() : 0;
    const bTime = b.job.created_at ? new Date(b.job.created_at).getTime() : 0;
    return bTime - aTime;
  });

  log('fetch', 'info', `Collected ${collected.length} Workable jobs`);

  const from = options.range ? options.range.from : 1;
  const to = options.range ? options.range.to : Math.min(collected.length, options.limit ?? 50);
  const sliced = collected.slice(from - 1, to);

  log('fetch', 'info', `Taking jobs ${from}–${to} out of ${collected.length} total`);

  const jobs: RawJob[] = sliced.map((entry, idx) => {
    const { companyName, subdomain, job: wJob } = entry;

    const location = wJob.location.telecommuting
      ? `Remote${wJob.location.location_str ? ` (${wJob.location.location_str})` : ''}`
      : wJob.location.location_str || null;

    const rawJob: RawJob = {
      id: crypto.randomUUID(),
      positionTitle: wJob.title || 'Unknown Position',
      company: companyName,
      location,
      applyLink: wJob.application_url || wJob.url || wJob.shortlink || null,
      datePosted: wJob.created_at ? wJob.created_at.split('T')[0] : null,
      salary: null,
      rawFields: {
        source: 'workable',
        workableId: wJob.id,
        workableShortcode: wJob.shortcode,
        subdomain,
        department: wJob.department || '',
        remote: String(wJob.location.telecommuting),
      },
    };

    log('fetch', 'info', `  [${idx + 1}] ${rawJob.company} — ${rawJob.positionTitle}`);
    return rawJob;
  });

  writeStep('step1-raw-jobs', jobs);
  log('fetch', 'info', `Step 1 complete: ${jobs.length} jobs saved (source: Workable)`);
  return jobs.length;
}
