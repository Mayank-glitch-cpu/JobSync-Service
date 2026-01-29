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
