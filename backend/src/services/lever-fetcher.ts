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
const LEVER_SLUGS_PATH = path.join(__dirname, '../../data/lever-slugs.json');

// Lever public postings API — no auth required
const LEVER_API_BASE = 'https://api.lever.co/v0/postings';

interface LeverSlugEntry {
  slug: string;
  name: string;
}

interface LeverCategories {
  commitment: string | null;  // Full-time, Part-time, Intern
  department: string | null;
  location: string | null;
  team: string | null;
  allLocations: string[];
}

interface LeverLists {
  text: string;
  content: string; // HTML
}

interface LeverJob {
  id: string;
  text: string; // Title
  hostedUrl: string;
  applyUrl: string;
  createdAt: number; // Unix timestamp (ms)
  categories: LeverCategories;
  descriptionPlain: string;
  lists: LeverLists[];
  additional: string;
  additionalPlain: string;
}

function loadLeverSlugs(): LeverSlugEntry[] {
  try {
    const raw = fs.readFileSync(LEVER_SLUGS_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    log('fetch', 'warn', 'lever-slugs.json not found, using default list');
    return DEFAULT_LEVER_SLUGS;
  }
}

const DEFAULT_LEVER_SLUGS: LeverSlugEntry[] = [
  { slug: 'Netflix', name: 'Netflix' },
  { slug: 'NVIDIA', name: 'NVIDIA' },
  { slug: 'coinbase', name: 'Coinbase' },
  { slug: 'spotify', name: 'Spotify' },
  { slug: 'twitch', name: 'Twitch' },
  { slug: 'lyft', name: 'Lyft' },
  { slug: 'snap', name: 'Snap' },
  { slug: 'pinterest', name: 'Pinterest' },
  { slug: 'palantir', name: 'Palantir' },
  { slug: 'atlassian', name: 'Atlassian' },
  { slug: 'datadog', name: 'Datadog' },
  { slug: 'confluent', name: 'Confluent' },
  { slug: 'hashicorp', name: 'HashiCorp' },
  { slug: 'dbtlabs', name: 'dbt Labs' },
  { slug: 'grafana', name: 'Grafana Labs' },
  { slug: 'linear', name: 'Linear' },
  { slug: 'supabase', name: 'Supabase' },
  { slug: 'clickhouse', name: 'ClickHouse' },
  { slug: 'cerebras-systems', name: 'Cerebras' },
  { slug: 'CharacterAI', name: 'Character.AI' },
  { slug: 'applied-intuition', name: 'Applied Intuition' },
  { slug: 'sambanova', name: 'SambaNova' },
  { slug: 'together-ai', name: 'Together AI' },
  { slug: 'huggingface', name: 'Hugging Face' },
  { slug: 'mistral', name: 'Mistral AI' },
  { slug: 'perplexityai', name: 'Perplexity AI' },
  { slug: 'cohere', name: 'Cohere' },
  { slug: 'elevenlabs', name: 'ElevenLabs' },
  { slug: 'shield-ai', name: 'Shield AI' },
  { slug: 'crusoe-energy', name: 'Crusoe Energy' },
  { slug: 'cleanlab', name: 'Cleanlab' },
  { slug: 'anyscale', name: 'Anyscale' },
  { slug: 'runway', name: 'Runway' },
  { slug: 'cursor1', name: 'Cursor' },
  { slug: 'replit', name: 'Replit' },
  { slug: 'weaviate', name: 'Weaviate' },
  { slug: 'qdrant', name: 'Qdrant' },
  { slug: 'modal-labs', name: 'Modal' },
];

export interface FetchLeverOptions {
  range?: { from: number; to: number };
  limit?: number;
  keywords?: string[];
  excludeKeywords?: string[];
  companySlugs?: string[];
  maxAgeDays?: number;
}

export async function fetchLever(options: FetchLeverOptions = {}): Promise<number> {
  const allSlugs = loadLeverSlugs();
  const selectedSlugs = options.companySlugs?.length
    ? allSlugs.filter((s) => options.companySlugs!.includes(s.slug))
    : allSlugs;

  const keywords = (options.keywords ?? []).map((k) => k.toLowerCase());
  const excludeKeywords = (options.excludeKeywords ?? []).map((k) => k.toLowerCase());
  const maxAgeDays = options.maxAgeDays ?? 7;
  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  log('fetch', 'info', `Fetching Lever jobs for ${selectedSlugs.length} companies...`);
  log('fetch', 'info', `Filters: keywords=${keywords.join(', ') || 'none'}, maxAgeDays=${maxAgeDays}`);

  const collected: Array<{ company: string; slug: string; job: LeverJob }> = [];

  for (const { slug, name } of selectedSlugs) {
    const url = `${LEVER_API_BASE}/${slug}?mode=json`;
    log('fetch', 'info', `  Fetching ${name} (${slug})...`);

    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        log('fetch', 'warn', `  Lever returned ${response.status} for ${slug}`);
        continue;
      }

      const jobs: LeverJob[] = await response.json();

      // Filter by recency (createdAt is in ms)
      const recent = jobs.filter((j) => j.createdAt >= cutoffMs);

      const filtered = recent.filter((j) =>
        passesTitleFilter(
          { title: j.text, department: j.categories.department, team: j.categories.team },
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

    await new Promise((r) => setTimeout(r, 300));
  }

  // Sort by createdAt descending
  collected.sort((a, b) => b.job.createdAt - a.job.createdAt);

  log('fetch', 'info', `Collected ${collected.length} Lever jobs`);

  const from = options.range ? options.range.from : 1;
  const to = options.range ? options.range.to : Math.min(collected.length, options.limit ?? 30);
  const sliced = collected.slice(from - 1, to);

  log('fetch', 'info', `Taking jobs ${from}–${to} out of ${collected.length} total`);

  const jobs: RawJob[] = sliced.map((entry, idx) => {
    const { company, slug, job: leverJob } = entry;
    const dateStr = new Date(leverJob.createdAt).toISOString().split('T')[0];

    // Build location from categories
    const location = leverJob.categories.allLocations?.length
      ? leverJob.categories.allLocations.join('; ')
      : leverJob.categories.location || null;

    const rawJob: RawJob = {
      id: crypto.randomUUID(),
      positionTitle: leverJob.text || 'Unknown Position',
      company,
      location,
      applyLink: leverJob.hostedUrl || leverJob.applyUrl || null,
      datePosted: dateStr,
      salary: null,
      rawFields: {
        source: 'lever',
        leverId: leverJob.id,
        leverSlug: slug,
        department: leverJob.categories.department || '',
        team: leverJob.categories.team || '',
        commitment: leverJob.categories.commitment || '',
      },
    };

    log('fetch', 'info', `  [${idx + 1}] ${rawJob.company} — ${rawJob.positionTitle}`);
    return rawJob;
  });

  writeStep('step1-raw-jobs', jobs);
  log('fetch', 'info', `Step 1 complete: ${jobs.length} jobs saved (source: Lever)`);
  return jobs.length;
}
