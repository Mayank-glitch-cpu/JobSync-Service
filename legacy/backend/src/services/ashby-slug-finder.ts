import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { log } from '../logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SLUGS_PATH = path.resolve(__dirname, '../../data/ashby-slugs.json');

const GOOGLE_SEARCH_URL = 'https://www.google.com/search';
const ASHBY_BOARD_URL = 'https://jobs.ashbyhq.com';
const ASHBY_POSTING_API = 'https://api.ashbyhq.com/posting-api/job-board';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const DEFAULT_QUERIES = [
  'site:jobs.ashbyhq.com',
  'site:jobs.ashbyhq.com engineer',
  'site:jobs.ashbyhq.com intern',
  'site:jobs.ashbyhq.com "new grad"',
  'site:jobs.ashbyhq.com data',
  'site:jobs.ashbyhq.com manager',
  'site:jobs.ashbyhq.com design',
  'site:jobs.ashbyhq.com marketing',
];

const RESERVED_PATHS = new Set(['api', 'job-board', 'embed', 'static', 'assets']);

interface SlugEntry {
  slug: string;
  name: string;
  verified?: boolean;
  lastVerified?: string;
  jobCount?: number;
  publicWebsite?: string | null;
}

export interface FindAshbySlugOptions {
  queries?: string[];
  resultsPerQuery?: number;
  delayMs?: number;
  dryRun?: boolean;
  /** Use Playwright (persistent headful browser) instead of plain fetch. Default false. */
  usePlaywright?: boolean;
  /** When usePlaywright is true, run headless. Default false (headful is harder to detect). */
  headless?: boolean;
  /** If plain fetch yields zero candidates, automatically fall back to Playwright. Default true. */
  autoFallbackToPlaywright?: boolean;
}

const PLAYWRIGHT_PROFILE_DIR = path.resolve(__dirname, '../../data/.playwright-profile');

function extractAshbyUrlsFromHtml(html: string): string[] {
  const urls = new Set<string>();
  const directRe = /https?:\/\/jobs\.ashbyhq\.com\/[^\s"'<>&]+/g;
  for (const m of html.matchAll(directRe)) urls.add(m[0]);
  const wrappedRe = /\/url\?q=(https?%3A%2F%2Fjobs\.ashbyhq\.com[^&"']+)/g;
  for (const m of html.matchAll(wrappedRe)) {
    try { urls.add(decodeURIComponent(m[1])); } catch { /* skip */ }
  }
  return Array.from(urls);
}

function isBlockedPage(html: string): boolean {
  return /\/sorry\/index|unusual traffic|detected unusual|recaptcha/i.test(html);
}

async function googleSearchPlaywright(
  queries: string[],
  resultsPerQuery: number,
  delayMs: number,
  headless: boolean
): Promise<Map<string, string[]>> {
  // Dynamic import so plain-fetch users don't pay the load cost.
  const { chromium } = await import('playwright');
  const results = new Map<string, string[]>();

  const context = await chromium.launchPersistentContext(PLAYWRIGHT_PROFILE_DIR, {
    headless,
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
  });

  try {
    const page = await context.newPage();
    for (const q of queries) {
      const url = `${GOOGLE_SEARCH_URL}?${new URLSearchParams({ q, num: String(resultsPerQuery), hl: 'en' })}`;
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        // Accept consent if present (EU consent wall).
        const consent = page.locator('button:has-text("Accept all"), button:has-text("I agree")').first();
        if (await consent.count().catch(() => 0)) {
          await consent.click({ timeout: 3000 }).catch(() => { /* ignore */ });
          await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => { /* ignore */ });
        }
        let html = await page.content();
        let blocked = isBlockedPage(html) || page.url().includes('/sorry/');
        if (blocked && !headless) {
          log('fetch', 'warn', `  "${q}" hit Google CAPTCHA — solve it in the browser window (up to 2 min)…`);
          try {
            await page.waitForURL((url) => !url.toString().includes('/sorry/'), { timeout: 120_000 });
            await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => { /* ignore */ });
            html = await page.content();
            blocked = isBlockedPage(html) || page.url().includes('/sorry/');
          } catch {
            // timeout — still blocked
          }
        }
        if (blocked) {
          log('fetch', 'warn', `  "${q}" blocked by Google — bailing (cookies saved for next run)`);
          break;
        }
        results.set(q, extractAshbyUrlsFromHtml(html));
      } catch (err) {
        log('fetch', 'warn', `  "${q}" playwright error: ${err instanceof Error ? err.message : String(err)}`);
        results.set(q, []);
      }
      // Randomize slightly to look less scripted.
      const jitter = delayMs + Math.floor(Math.random() * 1500);
      await sleep(jitter);
    }
  } finally {
    await context.close();
  }
  return results;
}

async function googleSearch(query: string, num: number): Promise<string[]> {
  const params = new URLSearchParams({ q: query, num: String(num), hl: 'en' });
  const url = `${GOOGLE_SEARCH_URL}?${params.toString()}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) {
    throw new Error(`google HTTP ${res.status}`);
  }
  const html = await res.text();
  if (isBlockedPage(html)) {
    throw new Error('google blocked (CAPTCHA/sorry page)');
  }
  return extractAshbyUrlsFromHtml(html);
}

function slugFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith('jobs.ashbyhq.com')) return null;
    const first = u.pathname.replace(/^\/+/, '').split('/')[0];
    if (!first) return null;
    if (RESERVED_PATHS.has(first)) return null;
    return first.toLowerCase();
  } catch {
    return null;
  }
}

interface OrganizationInfo {
  name: string;
  jobCount: number;
}

async function validateSlug(slug: string): Promise<OrganizationInfo | null> {
  const res = await fetch(`${ASHBY_POSTING_API}/${slug}?includeCompensation=false`, {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { jobs?: Array<{ isListed?: boolean }> };
  const jobs = body.jobs || [];
  const jobCount = jobs.filter((j) => j.isListed !== false).length;

  // Grab the org name from the board page <title> (format: "<Name> Jobs").
  let name = slug.charAt(0).toUpperCase() + slug.slice(1);
  try {
    const page = await fetch(`${ASHBY_BOARD_URL}/${slug}`, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (page.ok) {
      const html = await page.text();
      const title = html.match(/<title>([^<]+)<\/title>/)?.[1]?.trim();
      if (title) {
        const stripped = title.replace(/\s*Jobs\s*$/i, '').trim();
        if (stripped && stripped.toLowerCase() !== 'jobs') {
          name = stripped;
        }
      }
    }
  } catch {
    // fall back to title-cased slug
  }

  return { name, jobCount };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function findAshbySlugs(options: FindAshbySlugOptions = {}): Promise<number> {
  const queries = options.queries ?? DEFAULT_QUERIES;
  const resultsPerQuery = options.resultsPerQuery ?? 20;
  const delayMs = options.delayMs ?? 1500;

  log('fetch', 'info', '═══════════════════════════════════════════════════');
  log('fetch', 'info', ' Ashby Slug Finder (Google)');
  log('fetch', 'info', `  Queries: ${queries.length}`);
  log('fetch', 'info', `  Results/query: ${resultsPerQuery}`);
  log('fetch', 'info', '═══════════════════════════════════════════════════');

  const existing: SlugEntry[] = JSON.parse(await readFile(SLUGS_PATH, 'utf-8'));
  const existingBySlug = new Map(existing.map((e) => [e.slug.toLowerCase(), e]));

  const candidates = new Set<string>();
  const absorb = (q: string, urls: string[]) => {
    let added = 0;
    for (const url of urls) {
      const slug = slugFromUrl(url);
      if (slug) {
        if (!candidates.has(slug)) added++;
        candidates.add(slug);
      }
    }
    log('fetch', 'info', `  "${q}" → ${urls.length} urls, ${added} new slugs`);
  };

  const usePlaywright = options.usePlaywright ?? false;
  const autoFallback = options.autoFallbackToPlaywright ?? true;
  const headless = options.headless ?? false;

  if (usePlaywright) {
    log('fetch', 'info', `  mode: Playwright (headless=${headless})`);
    const map = await googleSearchPlaywright(queries, resultsPerQuery, delayMs, headless);
    for (const [q, urls] of map) absorb(q, urls);
  } else {
    log('fetch', 'info', '  mode: fetch');
    for (const q of queries) {
      try {
        absorb(q, await googleSearch(q, resultsPerQuery));
      } catch (err) {
        log('fetch', 'warn', `  "${q}" failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      await sleep(delayMs);
    }
    if (candidates.size === 0 && autoFallback) {
      log('fetch', 'warn', '  fetch mode yielded 0 candidates — falling back to Playwright');
      const map = await googleSearchPlaywright(queries, resultsPerQuery, delayMs, headless);
      for (const [q, urls] of map) absorb(q, urls);
    }
  }

  log('fetch', 'info', `  Total unique slug candidates: ${candidates.size}`);

  const today = new Date().toISOString().split('T')[0];
  let newCount = 0;
  let updatedCount = 0;

  for (const slug of Array.from(candidates).sort()) {
    try {
      const org = await validateSlug(slug);
      if (!org) {
        continue;
      }
      const entry: SlugEntry = {
        slug,
        name: org.name,
        verified: true,
        lastVerified: today,
        jobCount: org.jobCount,
      };

      const prior = existingBySlug.get(slug);
      if (prior) {
        existingBySlug.set(slug, { ...prior, ...entry });
        updatedCount++;
      } else {
        existingBySlug.set(slug, entry);
        newCount++;
        log('fetch', 'info', `  + ${slug} → ${org.name} (${org.jobCount} jobs)`);
      }
    } catch (err) {
      log('fetch', 'warn', `  skip ${slug}: ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(250);
  }

  const merged = Array.from(existingBySlug.values()).sort((a, b) => a.slug.localeCompare(b.slug));

  if (!options.dryRun) {
    await writeFile(SLUGS_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
  }

  log('fetch', 'info', '═══════════════════════════════════════════════════');
  log('fetch', 'info', ` Slug finder complete: ${newCount} new, ${updatedCount} updated, ${merged.length} total`);
  log('fetch', 'info', '═══════════════════════════════════════════════════');

  return newCount;
}

// Allow running directly: `tsx src/services/ashby-slug-finder.ts`
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const usePlaywright = process.argv.includes('--playwright');
  const headless = process.argv.includes('--headless');
  findAshbySlugs({ usePlaywright, headless }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
