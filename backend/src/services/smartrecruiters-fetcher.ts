import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../logger.js';
import { writeStep } from '../store.js';
import type { RawJob } from '../types.js';
import { passesTitleFilter } from './job-filter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SLUGS_PATH = path.join(__dirname, '../../data/smartrecruiters-slugs.json');

// SmartRecruiters Posting API — completely public, no auth required
// Docs: https://developers.smartrecruiters.com/docs/posting-api
const SR_API_BASE = 'https://api.smartrecruiters.com/v1/companies';

// ─── Types ──────────────────────────────────────────────────────────────

interface SRSlugEntry {
  identifier: string;
  name: string;
}

interface SRLocation {
  city?: string;
  region?: string;
  country?: string;
  remote?: boolean;
}

interface SRDepartment {
  id?: string;
  label?: string;
}

interface SRExperienceLevel {
  id?: string;
  label?: string;
}

interface SRPosting {
  id: string;
  uuid: string;
  name: string;
  refNumber?: string;
  releasedDate?: string;
  company: { identifier: string; name: string };
  location?: SRLocation;
  department?: SRDepartment;
  experienceLevel?: SRExperienceLevel;
  typeOfEmployment?: { id: string; label: string };
  ref?: string; // URL to full posting details
}

interface SRListResponse {
  totalFound: number;
  limit: number;
  offset: number;
  content: SRPosting[];
}

interface SRPostingDetail {
  id: string;
  uuid: string;
  name: string;
  releasedDate?: string;
  company: { identifier: string; name: string };
  location?: SRLocation;
  department?: SRDepartment;
  experienceLevel?: SRExperienceLevel;
  typeOfEmployment?: { id: string; label: string };
  jobAd?: {
    sections?: {
      jobDescription?: { title: string; text: string };
      qualifications?: { title: string; text: string };
      additionalInformation?: { title: string; text: string };
      companyDescription?: { title: string; text: string };
    };
  };
}

// ─── Default Company Slugs ──────────────────────────────────────────────

const DEFAULT_SLUGS: SRSlugEntry[] = [
  { identifier: 'Visa', name: 'Visa' },
  { identifier: 'MasterCard', name: 'Mastercard' },
  { identifier: 'Bosch-Group', name: 'Bosch' },
  { identifier: 'Skechers1', name: 'Skechers' },
  { identifier: 'SamsungSemiconductor', name: 'Samsung Semiconductor' },
  { identifier: 'McDonald', name: 'McDonalds' },
  { identifier: 'Adidas', name: 'Adidas' },
  { identifier: 'IHGHotelsAndResorts', name: 'IHG' },
  { identifier: 'Equinix', name: 'Equinix' },
  { identifier: 'AECOM', name: 'AECOM' },
  { identifier: 'TelusInternational', name: 'Telus International' },
  { identifier: 'DHL', name: 'DHL' },
  { identifier: 'DoorDash', name: 'DoorDash' },
  { identifier: 'IQVIA', name: 'IQVIA' },
  { identifier: 'Sprinklr', name: 'Sprinklr' },
  { identifier: 'MolsonCoors', name: 'Molson Coors' },
  { identifier: 'CelestialAI', name: 'Celestial AI' },
  { identifier: 'HelloFresh', name: 'HelloFresh' },
];

function loadSlugs(): SRSlugEntry[] {
  try {
    const raw = fs.readFileSync(SLUGS_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return DEFAULT_SLUGS;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function formatLocation(loc?: SRLocation): string | null {
  if (!loc) return null;
  if (loc.remote) return 'Remote';
  const parts = [loc.city, loc.region, loc.country].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

// ─── Fetch from SmartRecruiters ─────────────────────────────────────────

async function fetchCompanyPostings(
  identifier: string,
  query: string,
  limit: number
): Promise<SRPosting[]> {
  const allPostings: SRPosting[] = [];
  let offset = 0;
  const pageSize = Math.min(limit, 100);

  while (allPostings.length < limit) {
    const params = new URLSearchParams({
      limit: String(pageSize),
      offset: String(offset),
      ...(query ? { q: query } : {}),
    });

    const url = `${SR_API_BASE}/${identifier}/postings?${params}`;

    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        log('fetch', 'warn', `    SR API returned ${response.status} for ${identifier}`);
        break;
      }

      const result: SRListResponse = await response.json();

      if (!result.content?.length) break;

      allPostings.push(...result.content);
      offset += result.content.length;

      // Stop if we've fetched all available
      if (offset >= result.totalFound) break;
    } catch (err) {
      log('fetch', 'error', `    SR fetch error for ${identifier}: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }

    await sleep(200);
  }

  return allPostings.slice(0, limit);
}

async function fetchPostingDetail(
  identifier: string,
  postingId: string
): Promise<SRPostingDetail | null> {
  const url = `${SR_API_BASE}/${identifier}/postings/${postingId}`;

  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

// ─── Main Export ────────────────────────────────────────────────────────

export interface FetchSmartRecruitersOptions {
  range?: { from: number; to: number };
  limit?: number;
  /** Search query applied to all companies (e.g., "software engineer") */
  query?: string;
  /** Specific company identifiers to search. Uses all from slugs file if empty. */
  companyIdentifiers?: string[];
  /** Max postings to fetch per company. Default: 20. */
  perCompanyLimit?: number;
  /** Fetch full posting details (slower but gets description). Default: false. */
  fetchDetails?: boolean;
  /** Only include postings released within this many days. Default: 7. */
  maxAgeDays?: number;
}

export async function fetchSmartRecruiters(
  options: FetchSmartRecruitersOptions = {}
): Promise<number> {
  const allSlugs = loadSlugs();
  const selectedSlugs = options.companyIdentifiers?.length
    ? allSlugs.filter((s) =>
        options.companyIdentifiers!.some(
          (id) => id.toLowerCase() === s.identifier.toLowerCase()
        )
      )
    : allSlugs;

  const query = options.query ?? 'software engineer OR robotics OR UI UX developer OR AI ML engineer';
  const perCompanyLimit = options.perCompanyLimit ?? 20;
  const fetchDetails = options.fetchDetails ?? false;
  const maxAgeDays = options.maxAgeDays ?? 7;
  const cutoffDate = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);

  log('fetch', 'info', `Fetching SmartRecruiters jobs for ${selectedSlugs.length} companies...`);
  log('fetch', 'info', `  Query: "${query}", per-company limit: ${perCompanyLimit}, maxAgeDays: ${maxAgeDays}`);

  const collected: Array<{
    companyName: string;
    identifier: string;
    posting: SRPosting;
    detail?: SRPostingDetail | null;
  }> = [];

  for (const { identifier, name } of selectedSlugs) {
    log('fetch', 'info', `  Fetching ${name} (${identifier})...`);

    const postings = await fetchCompanyPostings(identifier, query, perCompanyLimit);

    // Filter by date
    const recent = postings.filter((p) => {
      if (!p.releasedDate) return true;
      const released = new Date(p.releasedDate);
      return !Number.isNaN(released.getTime()) && released >= cutoffDate;
    });

    // Filter by title (shared new-grad / technical filter)
    const filtered = recent.filter((p) => passesTitleFilter({ title: p.name }));

    log('fetch', 'info', `    ${name}: ${postings.length} found → ${recent.length} recent → ${filtered.length} matched`);

    // Optionally fetch full details
    if (fetchDetails) {
      for (const posting of filtered) {
        const detail = await fetchPostingDetail(identifier, posting.id);
        collected.push({ companyName: name, identifier, posting, detail });
        await sleep(150);
      }
    } else {
      for (const posting of filtered) {
        collected.push({ companyName: name, identifier, posting });
      }
    }

    await sleep(300);
  }

  // Sort by releasedDate descending
  collected.sort((a, b) => {
    const aTime = a.posting.releasedDate ? new Date(a.posting.releasedDate).getTime() : 0;
    const bTime = b.posting.releasedDate ? new Date(b.posting.releasedDate).getTime() : 0;
    return bTime - aTime;
  });

  log('fetch', 'info', `Collected ${collected.length} SmartRecruiters jobs`);

  const from = options.range ? options.range.from : 1;
  const to = options.range ? options.range.to : Math.min(collected.length, options.limit ?? 50);
  const sliced = collected.slice(from - 1, to);

  log('fetch', 'info', `Taking jobs ${from}–${to} out of ${collected.length} total`);

  const jobs: RawJob[] = sliced.map((entry, idx) => {
    const { companyName, identifier, posting, detail } = entry;

    // Build apply URL
    const applyUrl = `https://jobs.smartrecruiters.com/${identifier}/${posting.id}`;

    // Extract description from detail if available
    let description: string | null = null;
    if (detail?.jobAd?.sections) {
      const sections = detail.jobAd.sections;
      const parts = [
        sections.jobDescription?.text,
        sections.qualifications?.text,
        sections.additionalInformation?.text,
      ].filter(Boolean);
      description = parts.join('\n\n').replace(/<[^>]+>/g, ' ').slice(0, 5000) || null;
    }

    const job: RawJob = {
      id: crypto.randomUUID(),
      positionTitle: posting.name || 'Unknown Position',
      company: posting.company?.name || companyName,
      location: formatLocation(posting.location),
      applyLink: applyUrl,
      datePosted: posting.releasedDate ? posting.releasedDate.split('T')[0] : null,
      salary: null,
      rawFields: {
        source: 'smartrecruiters',
        srId: posting.id,
        srUuid: posting.uuid,
        srIdentifier: identifier,
        department: posting.department?.label || '',
        experienceLevel: posting.experienceLevel?.label || '',
        employmentType: posting.typeOfEmployment?.label || '',
        refNumber: posting.refNumber || '',
        ...(description ? { description: description.slice(0, 2000) } : {}),
      },
    };

    log('fetch', 'info', `  [${idx + 1}] ${job.company} — ${job.positionTitle}`);
    return job;
  });

  writeStep('step1-raw-jobs', jobs);
  log('fetch', 'info', `Step 1 complete: ${jobs.length} jobs saved (source: SmartRecruiters)`);
  return jobs.length;
}
