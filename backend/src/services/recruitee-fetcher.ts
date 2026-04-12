import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../logger.js';
import { writeStep } from '../store.js';
import type { RawJob } from '../types.js';
import { passesTitleFilter } from './job-filter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SLUGS_PATH = path.join(__dirname, '../../data/recruitee-slugs.json');

// Recruitee public Careers Site API — no auth required
// Endpoint: GET https://{company}.recruitee.com/api/offers
// Docs: https://docs.recruitee.com/reference/intro-to-careers-site-api

interface RecruiteeSalary {
  min?: number;
  max?: number;
  currency?: string;
  period?: string;
}

interface RecruiteeOffer {
  id: number;
  slug: string;
  title: string;
  department: string | null;
  location: string | null;
  city: string | null;
  country: string | null;
  country_code: string | null;
  remote: boolean;
  position: string | null; // Full-time, Part-time, etc.
  careers_url: string;
  careers_apply_url: string;
  published_at: string | null;
  created_at: string;
  min_hours?: number;
  max_hours?: number;
  salary?: RecruiteeSalary;
  tags: string[];
  description: string | null;
}

interface RecruiteeResponse {
  offers: RecruiteeOffer[];
}

interface SlugEntry {
  subdomain: string;
  name: string;
}

const DEFAULT_SLUGS: SlugEntry[] = [
  { subdomain: 'tomtom', name: 'TomTom' },
  { subdomain: 'hotjar', name: 'Hotjar' },
  { subdomain: 'wolt', name: 'Wolt' },
  { subdomain: 'factorial', name: 'Factorial' },
  { subdomain: 'bynder', name: 'Bynder' },
  { subdomain: 'messagebird', name: 'MessageBird' },
  { subdomain: 'framer', name: 'Framer' },
  { subdomain: 'sketch', name: 'Sketch' },
  { subdomain: 'pitch', name: 'Pitch' },
  { subdomain: 'maze', name: 'Maze' },
  { subdomain: 'tinybird', name: 'Tinybird' },
  { subdomain: 'remote', name: 'Remote.com' },
  { subdomain: 'fonoa', name: 'Fonoa' },
  { subdomain: 'gigs', name: 'Gigs' },
  { subdomain: 'mollie', name: 'Mollie' },
  { subdomain: 'packhelp', name: 'Packhelp' },
  { subdomain: 'frontify', name: 'Frontify' },
  { subdomain: 'veed', name: 'VEED.IO' },
  { subdomain: 'mimo', name: 'Mimo' },
  { subdomain: 'n8n', name: 'n8n' },
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

function formatSalary(salary?: RecruiteeSalary): string | null {
  if (!salary?.min && !salary?.max) return null;
  const currency = salary.currency || 'EUR';
  const period = salary.period === 'year' ? '/yr' : salary.period === 'month' ? '/mo' : '';
  if (salary.min && salary.max) {
    return `${currency} ${salary.min.toLocaleString()}–${salary.max.toLocaleString()}${period}`;
  }
  const val = salary.min || salary.max;
  return `${currency} ${val!.toLocaleString()}${period}`;
}

function formatLocation(offer: RecruiteeOffer): string | null {
  if (offer.remote) {
    const base = [offer.city, offer.country].filter(Boolean).join(', ');
    return base ? `Remote (${base})` : 'Remote';
  }
  if (offer.location) return offer.location;
  const parts = [offer.city, offer.country].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

// ─── Main Export ────────────────────────────────────────────────────────

export interface FetchRecruiteeOptions {
  range?: { from: number; to: number };
  limit?: number;
  /** Specific company subdomains. Uses all from slugs file if empty. */
  subdomains?: string[];
  /** Title keyword filter. Applied client-side. */
  keywords?: string[];
  /** Exclude titles matching these keywords. */
  excludeKeywords?: string[];
  /** Only include postings published within this many days. Default: 14. */
  maxAgeDays?: number;
}

export async function fetchRecruitee(options: FetchRecruiteeOptions = {}): Promise<number> {
  const allSlugs = loadSlugs();
  const selectedSlugs = options.subdomains?.length
    ? allSlugs.filter((s) =>
        options.subdomains!.some((sd) => sd.toLowerCase() === s.subdomain.toLowerCase())
      )
    : allSlugs;

  const keywords = (options.keywords ?? []).map((k) => k.toLowerCase());
  const excludeKeywords = (options.excludeKeywords ?? []).map((k) => k.toLowerCase());
  const maxAgeDays = options.maxAgeDays ?? 14;
  const cutoffDate = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);

  log('fetch', 'info', `Fetching Recruitee jobs for ${selectedSlugs.length} companies...`);

  const collected: Array<{ companyName: string; subdomain: string; offer: RecruiteeOffer }> = [];

  for (const { subdomain, name } of selectedSlugs) {
    const url = `https://${subdomain}.recruitee.com/api/offers`;
    log('fetch', 'info', `  Fetching ${name} (${subdomain})...`);

    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        log('fetch', 'warn', `    Recruitee returned ${response.status} for ${subdomain}`);
        continue;
      }

      const result: RecruiteeResponse = await response.json();
      const offers = result.offers || [];

      // Date filter
      const recent = offers.filter((o) => {
        const pubDate = new Date(o.published_at || o.created_at);
        return !Number.isNaN(pubDate.getTime()) && pubDate >= cutoffDate;
      });

      const filtered = recent.filter((o) =>
        passesTitleFilter(
          { title: o.title },
          { include: keywords.length ? keywords : undefined, exclude: excludeKeywords.length ? excludeKeywords : undefined }
        )
      );

      log('fetch', 'info', `    ${name}: ${offers.length} total → ${recent.length} recent → ${filtered.length} matched`);

      for (const offer of filtered) {
        collected.push({ companyName: name, subdomain, offer });
      }
    } catch (err) {
      log('fetch', 'error', `    ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    await sleep(400);
  }

  // Sort by published_at descending
  collected.sort((a, b) => {
    const aTime = new Date(a.offer.published_at || a.offer.created_at).getTime() || 0;
    const bTime = new Date(b.offer.published_at || b.offer.created_at).getTime() || 0;
    return bTime - aTime;
  });

  log('fetch', 'info', `Collected ${collected.length} Recruitee jobs`);

  const from = options.range ? options.range.from : 1;
  const to = options.range ? options.range.to : Math.min(collected.length, options.limit ?? 50);
  const sliced = collected.slice(from - 1, to);

  log('fetch', 'info', `Taking jobs ${from}–${to} out of ${collected.length} total`);

  const jobs: RawJob[] = sliced.map((entry, idx) => {
    const { companyName, subdomain, offer } = entry;

    const job: RawJob = {
      id: crypto.randomUUID(),
      positionTitle: offer.title || 'Unknown Position',
      company: companyName,
      location: formatLocation(offer),
      applyLink: offer.careers_apply_url || offer.careers_url || null,
      datePosted: (offer.published_at || offer.created_at)?.split('T')[0] || null,
      salary: formatSalary(offer.salary),
      rawFields: {
        source: 'recruitee',
        recruiteeId: String(offer.id),
        recruiteeSlug: offer.slug,
        subdomain,
        department: offer.department || '',
        position: offer.position || '',
        tags: offer.tags?.join(', ') || '',
        remote: String(offer.remote),
      },
    };

    log('fetch', 'info', `  [${idx + 1}] ${job.company} — ${job.positionTitle}`);
    return job;
  });

  writeStep('step1-raw-jobs', jobs);
  log('fetch', 'info', `Step 1 complete: ${jobs.length} jobs saved (source: Recruitee)`);
  return jobs.length;
}
