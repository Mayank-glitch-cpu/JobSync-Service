import crypto from 'node:crypto';
import * as cheerio from 'cheerio';
import { log } from '../logger.js';
import { writeStep } from '../store.js';
import type { RawJob } from '../types.js';

// Wellfound doesn't have a public API, so we scrape the search pages
const WELLFOUND_BASE = 'https://wellfound.com';

interface WellfoundPosting {
  title: string;
  company: string;
  location: string | null;
  salary: string | null;
  applyLink: string;
  remote: boolean;
}

/**
 * Scrape Wellfound role listing pages.
 * Wellfound has structured URLs: /role/{role-slug}
 */
async function scrapeWellfoundPage(url: string): Promise<WellfoundPosting[]> {
  const postings: WellfoundPosting[] = [];

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
    });

    if (!response.ok) {
      log('fetch', 'warn', `  Wellfound returned ${response.status} for ${url}`);
      return postings;
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Parse job listings from Wellfound HTML structure
    // Selectors may need adjustment as Wellfound updates their markup
    $('[data-test="StartupResult"], .styles_jobListing__*, .job-listing').each((_, el) => {
      const $el = $(el);
      const title = $el.find('[data-test="JobTitle"], h2 a, .styles_title__*').first().text().trim();
      const company = $el.find('[data-test="StartupName"], .styles_name__*, .startup-link').first().text().trim();
      const location = $el.find('[data-test="Location"], .styles_location__*').first().text().trim() || null;
      const salary = $el.find('[data-test="Compensation"], .styles_compensation__*').first().text().trim() || null;
      const linkEl = $el.find('a[href*="/jobs/"]').first();
      const href = linkEl.attr('href') || '';
      const applyLink = href.startsWith('http') ? href : `${WELLFOUND_BASE}${href}`;

      if (title && company) {
        postings.push({
          title,
          company,
          location,
          salary,
          applyLink,
          remote: /remote/i.test(location || ''),
        });
      }
    });
  } catch (err) {
    log('fetch', 'error', `  Wellfound scrape failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return postings;
}

export interface FetchWellfoundOptions {
  range?: { from: number; to: number };
  limit?: number;
  roles?: string[];
}

const DEFAULT_ROLES = [
  'software-engineer',
  'machine-learning-engineer',
  'data-scientist',
  'backend-engineer',
  'full-stack-engineer',
  'frontend-engineer',
  'devops-engineer',
  'data-engineer',
  'ai-engineer',
];

export async function fetchWellfound(options: FetchWellfoundOptions = {}): Promise<number> {
  const roles = options.roles ?? DEFAULT_ROLES;

  log('fetch', 'info', `Fetching jobs from Wellfound (${roles.length} role categories)...`);

  const allPostings: WellfoundPosting[] = [];

  for (const role of roles) {
    const url = `${WELLFOUND_BASE}/role/${role}`;
    log('fetch', 'info', `  Fetching role: ${role}...`);

    const postings = await scrapeWellfoundPage(url);
    log('fetch', 'info', `  ${role}: ${postings.length} listings found`);
    allPostings.push(...postings);

    await new Promise((r) => setTimeout(r, 1500)); // Respectful rate limiting
  }

  // Dedupe by applyLink
  const deduped = Array.from(
    new Map(allPostings.map((p) => [p.applyLink, p])).values()
  );

  log('fetch', 'info', `Received ${deduped.length} unique jobs from Wellfound`);

  const from = options.range ? options.range.from : 1;
  const to = options.range ? options.range.to : Math.min(deduped.length, options.limit ?? 25);
  const sliced = deduped.slice(from - 1, to);

  log('fetch', 'info', `Taking jobs ${from}–${to} out of ${deduped.length} total`);

  const jobs: RawJob[] = sliced.map((item, idx) => {
    const job: RawJob = {
      id: crypto.randomUUID(),
      positionTitle: item.title || 'Unknown Position',
      company: item.company || 'Unknown Company',
      location: item.remote ? 'Remote' : item.location,
      applyLink: item.applyLink || null,
      datePosted: new Date().toISOString().split('T')[0], // Wellfound doesn't show post dates easily
      salary: item.salary,
      rawFields: {
        source: 'wellfound',
        remote: String(item.remote),
      },
    };

    log('fetch', 'info', `  [${idx + 1}] ${job.company} — ${job.positionTitle}`);
    return job;
  });

  writeStep('step1-raw-jobs', jobs);
  log('fetch', 'info', `Step 1 complete: ${jobs.length} jobs saved (source: Wellfound)`);
  return jobs.length;
}
