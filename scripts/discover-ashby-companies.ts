#!/usr/bin/env npx tsx
/**
 * Ashby Company Slug Discovery Script
 *
 * Discovers new Ashby company slugs by probing the public API with candidates
 * derived from the existing companies.json database and curated seed lists.
 *
 * Usage:
 *   npx tsx scripts/discover-ashby-companies.ts              # Full discovery + verification
 *   npx tsx scripts/discover-ashby-companies.ts --verify-only # Re-verify existing slugs only
 *   npx tsx scripts/discover-ashby-companies.ts --merge       # Merge seeds without verifying
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASHBY_SLUGS_PATH = path.resolve(__dirname, '../backend/data/ashby-slugs.json');
const COMPANIES_PATH = path.resolve(__dirname, '../backend/data/companies.json');
const ASHBY_API_BASE = 'https://api.ashbyhq.com/posting-api/job-board';
const REQUEST_DELAY_MS = 200;

interface SlugEntry {
  slug: string;
  name: string;
  verified: boolean;
  lastVerified: string;
  jobCount?: number;
}

interface CompanyEntry {
  name: string;
  [key: string]: unknown;
}

// Additional curated slugs not in the main list (known Ashby customers)
const EXTRA_SEED_SLUGS: Array<{ slug: string; name: string }> = [
  { slug: 'lattice', name: 'Lattice' },
  { slug: 'zapier', name: 'Zapier' },
  { slug: 'notion', name: 'Notion' },
  { slug: 'agilebits', name: '1Password' },
  { slug: 'lob', name: 'Lob' },
  { slug: 'cockroach-labs', name: 'Cockroach Labs' },
  { slug: 'lightstep', name: 'Lightstep' },
  { slug: 'mux', name: 'Mux' },
  { slug: 'netlify', name: 'Netlify' },
  { slug: 'oxide', name: 'Oxide' },
  { slug: 'pagerduty', name: 'PagerDuty' },
  { slug: 'segment', name: 'Segment' },
  { slug: 'sift', name: 'Sift' },
  { slug: 'stitch-fix', name: 'Stitch Fix' },
  { slug: 'teleport', name: 'Teleport' },
  { slug: 'thorn', name: 'Thorn' },
  { slug: 'yext', name: 'Yext' },
  { slug: 'greenhouse', name: 'Greenhouse' },
  { slug: 'gem', name: 'Gem' },
  { slug: 'bereal', name: 'BeReal' },
  { slug: 'midjourney', name: 'Midjourney' },
  { slug: 'groq', name: 'Groq' },
  { slug: 'cerebras', name: 'Cerebras' },
  { slug: 'sambanova', name: 'SambaNova' },
  { slug: 'inflection', name: 'Inflection AI' },
  { slug: 'xai', name: 'xAI' },
  { slug: 'deepmind', name: 'DeepMind' },
  { slug: 'palantir', name: 'Palantir' },
  { slug: 'flexport', name: 'Flexport' },
  { slug: 'lyft', name: 'Lyft' },
  { slug: 'robinhood', name: 'Robinhood' },
  { slug: 'sofi', name: 'SoFi' },
  { slug: 'toast-inc', name: 'Toast' },
  { slug: 'twitch', name: 'Twitch' },
  { slug: 'uber', name: 'Uber' },
  { slug: 'wish', name: 'Wish' },
  { slug: 'zillow', name: 'Zillow' },
  { slug: 'dropbox', name: 'Dropbox' },
  { slug: 'gitlab', name: 'GitLab' },
  { slug: 'elastic', name: 'Elastic' },
  { slug: 'cloudflare', name: 'Cloudflare' },
  { slug: 'confluent', name: 'Confluent' },
  { slug: 'mongodb', name: 'MongoDB' },
  { slug: 'okta', name: 'Okta' },
  { slug: 'palo-alto-networks', name: 'Palo Alto Networks' },
  { slug: 'crowdstrike', name: 'CrowdStrike' },
  { slug: 'zscaler', name: 'Zscaler' },
  { slug: 'splunk', name: 'Splunk' },
  { slug: 'snowflake-computing', name: 'Snowflake' },
  { slug: 'nutanix', name: 'Nutanix' },
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function companyNameToSlugCandidates(name: string): string[] {
  const base = name
    .toLowerCase()
    .replace(/\s*\(.*?\)\s*/g, '') // Remove parentheticals like "(Alphabet)"
    .replace(/[^a-z0-9\s-]/g, '') // Remove special chars
    .trim();

  if (!base) return [];

  const candidates = new Set<string>();
  candidates.add(base.replace(/\s+/g, '-')); // "Scale AI" -> "scale-ai"
  candidates.add(base.replace(/\s+/g, '')); // "Scale AI" -> "scaleai"

  const firstWord = base.split(/\s+/)[0];
  if (firstWord && firstWord.length > 2) {
    candidates.add(firstWord); // "Scale AI" -> "scale"
  }

  return [...candidates].filter(Boolean);
}

async function verifySlug(slug: string): Promise<{ valid: boolean; jobCount: number }> {
  try {
    const res = await fetch(`${ASHBY_API_BASE}/${slug}?includeCompensation=false`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'JobSync-Discovery/1.0',
      },
    });
    if (!res.ok) return { valid: false, jobCount: 0 };
    const data = (await res.json()) as { jobs?: unknown[] };
    const jobs = data.jobs ?? [];
    return { valid: true, jobCount: jobs.length };
  } catch {
    return { valid: false, jobCount: 0 };
  }
}

function loadExistingSlugs(): SlugEntry[] {
  try {
    const raw = fs.readFileSync(ASHBY_SLUGS_PATH, 'utf-8');
    return JSON.parse(raw) as SlugEntry[];
  } catch {
    return [];
  }
}

function loadCompanyNames(): string[] {
  try {
    const raw = fs.readFileSync(COMPANIES_PATH, 'utf-8');
    const companies = JSON.parse(raw) as CompanyEntry[];
    return companies.map((c) => c.name).filter(Boolean);
  } catch {
    return [];
  }
}

function saveSlugEntries(entries: SlugEntry[]): void {
  const sorted = entries.sort((a, b) => a.slug.localeCompare(b.slug));
  fs.writeFileSync(ASHBY_SLUGS_PATH, JSON.stringify(sorted, null, 2) + '\n', 'utf-8');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const verifyOnly = args.includes('--verify-only');
  const mergeOnly = args.includes('--merge');

  const existing = loadExistingSlugs();
  const existingMap = new Map<string, SlugEntry>(existing.map((e) => [e.slug, e]));
  const today = new Date().toISOString().split('T')[0];

  console.log(`Loaded ${existing.length} existing slugs from ashby-slugs.json`);

  if (verifyOnly) {
    // Re-verify existing slugs
    console.log('\n--- Re-verifying existing slugs ---');
    let verified = 0;
    let invalid = 0;

    for (const entry of existing) {
      const { valid, jobCount } = await verifySlug(entry.slug);
      if (valid) {
        entry.verified = true;
        entry.lastVerified = today;
        entry.jobCount = jobCount;
        verified++;
        console.log(`  [OK] ${entry.slug} (${jobCount} jobs)`);
      } else {
        entry.verified = false;
        entry.lastVerified = today;
        invalid++;
        console.log(`  [FAIL] ${entry.slug}`);
      }
      await sleep(REQUEST_DELAY_MS);
    }

    saveSlugEntries(existing);
    console.log(`\nVerification complete: ${verified} valid, ${invalid} invalid out of ${existing.length}`);
    return;
  }

  // Gather candidate slugs from multiple sources
  const candidateSlugs = new Map<string, string>(); // slug -> name

  if (!mergeOnly) {
    // Source 1: Company names from companies.json
    const companyNames = loadCompanyNames();
    console.log(`\nLoaded ${companyNames.length} company names from companies.json`);

    for (const name of companyNames) {
      const candidates = companyNameToSlugCandidates(name);
      for (const slug of candidates) {
        if (!existingMap.has(slug) && !candidateSlugs.has(slug)) {
          candidateSlugs.set(slug, name);
        }
      }
    }
  }

  // Source 2: Extra curated seeds
  for (const { slug, name } of EXTRA_SEED_SLUGS) {
    if (!existingMap.has(slug) && !candidateSlugs.has(slug)) {
      candidateSlugs.set(slug, name);
    }
  }

  console.log(`${candidateSlugs.size} new candidate slugs to probe`);

  if (mergeOnly) {
    // Just merge extra seeds without verification
    for (const [slug, name] of candidateSlugs) {
      existingMap.set(slug, {
        slug,
        name,
        verified: false,
        lastVerified: today,
      });
    }
    saveSlugEntries([...existingMap.values()]);
    console.log(`Merged ${candidateSlugs.size} new entries (unverified). Total: ${existingMap.size}`);
    return;
  }

  // Probe candidates against the Ashby API
  console.log('\n--- Probing candidate slugs ---');
  let discovered = 0;
  let probed = 0;

  for (const [slug, name] of candidateSlugs) {
    probed++;
    if (probed % 50 === 0) {
      console.log(`  Progress: ${probed}/${candidateSlugs.size} probed, ${discovered} discovered...`);
    }

    const { valid, jobCount } = await verifySlug(slug);
    if (valid) {
      discovered++;
      console.log(`  [NEW] ${slug} -> ${name} (${jobCount} jobs)`);
      existingMap.set(slug, {
        slug,
        name,
        verified: true,
        lastVerified: today,
        jobCount,
      });
    }
    await sleep(REQUEST_DELAY_MS);
  }

  saveSlugEntries([...existingMap.values()]);
  console.log(`\nDiscovery complete: ${discovered} new slugs found out of ${candidateSlugs.size} candidates`);
  console.log(`Total slugs in ashby-slugs.json: ${existingMap.size}`);
}

main().catch((err) => {
  console.error('Discovery script failed:', err);
  process.exit(1);
});
