import * as cheerio from 'cheerio';
import { log } from '../logger.js';
import { readStep, writeStep } from '../store.js';
import type { RawJob, ScrapedJob } from '../types.js';

const JD_SELECTORS = [
  '[class*="job-description"]',
  '[class*="jobDescription"]',
  '[class*="job_description"]',
  '[class*="description"]',
  '[id*="job-description"]',
  '[id*="jobDescription"]',
  'article',
  '[role="main"]',
  'main',
  '.content',
  '#content',
];

function extractJD(html: string): string {
  const $ = cheerio.load(html);

  // Remove scripts, styles, nav, footer
  $('script, style, nav, footer, header, iframe, noscript').remove();

  // Try specific JD selectors
  for (const selector of JD_SELECTORS) {
    const el = $(selector);
    if (el.length > 0) {
      const text = el.first().text().replace(/\s+/g, ' ').trim();
      if (text.length > 100) {
        return text.slice(0, 8000);
      }
    }
  }

  // Fallback: body text
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  return bodyText.slice(0, 5000);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ASHBY_URL_RE = /^https?:\/\/jobs\.ashbyhq\.com\/([^/]+)\/([0-9a-f-]{36})(?:\/.*)?$/i;

function htmlToText(html: string): string {
  const $ = cheerio.load(html);
  $('script, style').remove();
  return $.root().text().replace(/\s+/g, ' ').trim();
}

async function fetchAshbyJD(applyLink: string): Promise<string | null> {
  const m = applyLink.match(ASHBY_URL_RE);
  if (!m) return null;
  const [, slug, jobId] = m;
  const url = `https://api.ashbyhq.com/posting-api/job-board/${slug}/${jobId}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'JobSync-Service/1.0' },
    });
    let data: { descriptionHtml?: string; descriptionPlain?: string } | null = null;
    if (res.ok) {
      data = await res.json();
    } else {
      // Fallback: fetch full board and locate job by id
      const boardRes = await fetch(
        `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`,
        { headers: { Accept: 'application/json', 'User-Agent': 'JobSync-Service/1.0' } }
      );
      if (!boardRes.ok) return null;
      const board: { jobs?: Array<{ id: string; descriptionHtml?: string; descriptionPlain?: string }> } = await boardRes.json();
      data = board.jobs?.find((j) => j.id === jobId) || null;
    }
    if (!data) return null;
    const text = data.descriptionPlain?.trim() || (data.descriptionHtml ? htmlToText(data.descriptionHtml) : '');
    return text && text.length >= 50 ? text.slice(0, 8000) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function scrapeJDs(): Promise<number> {
  const jobs = readStep<RawJob[]>('step1-raw-jobs');
  if (!jobs || jobs.length === 0) {
    throw new Error('No jobs found from Step 1. Run Step 1 first.');
  }

  log('scrape', 'info', `Starting JD scraping for ${jobs.length} jobs...`);

  const results: ScrapedJob[] = [];

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const scraped: ScrapedJob = {
      ...job,
      jobDescription: null,
      scrapeStatus: 'skipped',
    };

    if (!job.applyLink) {
      log('scrape', 'warn', `  [${i + 1}/${jobs.length}] ${job.company} — No apply link, skipping`);
      results.push(scraped);
      continue;
    }

    try {
      log('scrape', 'info', `  [${i + 1}/${jobs.length}] Scraping ${job.company} — ${job.applyLink}`);

      const ashbyJD = await fetchAshbyJD(job.applyLink);
      if (ashbyJD) {
        scraped.jobDescription = ashbyJD;
        scraped.scrapeStatus = 'success';
        log('scrape', 'info', `  [${i + 1}] ${job.company} — OK via Ashby API (${ashbyJD.length} chars)`);
        results.push(scraped);
        if (i < jobs.length - 1) await sleep(500);
        continue;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      const response = await fetch(job.applyLink, {
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
        },
        redirect: 'follow',
      });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const html = await response.text();
      const jd = extractJD(html);

      if (jd.length < 50) {
        scraped.scrapeStatus = 'failed';
        scraped.scrapeError = 'Extracted text too short (possible JS-rendered page)';
        log('scrape', 'warn', `  [${i + 1}] ${job.company} — JD too short, likely JS-rendered`);
      } else {
        scraped.jobDescription = jd;
        scraped.scrapeStatus = 'success';
        log('scrape', 'info', `  [${i + 1}] ${job.company} — OK (${jd.length} chars)`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      scraped.scrapeStatus = 'failed';
      scraped.scrapeError = msg;
      log('scrape', 'error', `  [${i + 1}] ${job.company} — Failed: ${msg}`);
    }

    results.push(scraped);

    // Rate limiting: 1 second between requests
    if (i < jobs.length - 1) {
      await sleep(1000);
    }
  }

  const succeeded = results.filter((j) => j.scrapeStatus === 'success').length;
  const failed = results.filter((j) => j.scrapeStatus === 'failed').length;
  const skipped = results.filter((j) => j.scrapeStatus === 'skipped').length;

  writeStep('step2-scraped-jobs', results);
  log('scrape', 'info', `Step 2 complete: ${succeeded} scraped, ${failed} failed, ${skipped} skipped`);
  return results.length;
}
