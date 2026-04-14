import crypto from 'node:crypto';
import { log } from '../logger.js';
import { writeStep } from '../store.js';
import type { RawJob } from '../types.js';

const README_URL =
  'https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/README.md';

const SECTIONS = [
  'Software Engineering',
  'Product Management',
  'Data Science, AI & Machine Learning',
  'Quantitative Finance',
  'Hardware Engineering',
  'Other',
];

interface ParsedRow {
  company: string;
  role: string;
  location: string;
  applyLink: string | null;
  age: string;
  category: string;
}

/** Extract clean text from HTML content */
function cleanText(raw: string): string {
  return raw
    .replace(/<details>[\s\S]*?<\/details>/g, (match) => {
      // Extract locations from <details> blocks
      const body = match
        .replace(/<\/?details>/g, '')
        .replace(/<\/?summary>/g, '')
        .replace(/<br\s*\/?>/g, ', ')
        .replace(/<[^>]+>/g, '')
        .trim();
      return body;
    })
    .replace(/<[^>]+>/g, '')   // strip remaining HTML tags
    .replace(/\*\*/g, '')      // strip bold markdown
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [text](url) -> text
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')    // remove images
    .replace(/\s+/g, ' ')     // normalize whitespace
    .trim();
}

/** Extract the first href from HTML content */
function extractLink(raw: string): string | null {
  const hrefMatch = raw.match(/href="([^"]+)"/);
  if (hrefMatch) return hrefMatch[1];
  return null;
}

/**
 * Parse an HTML <table> section from the README.
 * The tables use <tr>/<td> elements, not markdown pipes.
 * Each <tr> can span multiple lines.
 */
function parseSection(sectionText: string, category: string): ParsedRow[] {
  const rows: ParsedRow[] = [];

  // Find the <tbody> content
  const tbodyMatch = sectionText.match(/<tbody>([\s\S]*?)<\/tbody>/);
  if (!tbodyMatch) return rows;

  // Extract all <tr>...</tr> blocks
  const trRegex = /<tr>([\s\S]*?)<\/tr>/g;
  let trMatch;
  while ((trMatch = trRegex.exec(tbodyMatch[1])) !== null) {
    const trContent = trMatch[1];

    // Extract all <td>...</td> cells
    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
    const cells: string[] = [];
    let tdMatch;
    while ((tdMatch = tdRegex.exec(trContent)) !== null) {
      cells.push(tdMatch[1]);
    }

    if (cells.length < 5) continue;

    const [companyRaw, roleRaw, locationRaw, applicationRaw, ageRaw] = cells;
    const age = cleanText(ageRaw);

    rows.push({
      company: cleanText(companyRaw),
      role: cleanText(roleRaw),
      location: cleanText(locationRaw),
      applyLink: extractLink(applicationRaw),
      age,
      category,
    });
  }

  return rows;
}

export async function fetchGitHub(range?: { from: number; to: number }): Promise<number> {
  log('fetch', 'info', 'Fetching jobs from GitHub (SimplifyJobs/New-Grad-Positions)...');

  const response = await fetch(README_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch README: ${response.status} ${response.statusText}`);
  }

  const markdown = await response.text();
  log('fetch', 'info', `Received README (${markdown.length} bytes)`);

  const allRows: ParsedRow[] = [];

  // Split by ## sections and parse each
  for (const section of SECTIONS) {
    // Find section header line index
    const headerPattern = new RegExp(`^## .+${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm');
    const headerMatch = markdown.match(headerPattern);
    if (!headerMatch || headerMatch.index === undefined) {
      log('fetch', 'warn', `Section "${section}" not found, skipping`);
      continue;
    }

    // Extract from this header to the next ## or end
    const startIdx = headerMatch.index;
    const rest = markdown.slice(startIdx + headerMatch[0].length);
    const nextSection = rest.match(/^## /m);
    const sectionText = nextSection && nextSection.index !== undefined
      ? rest.slice(0, nextSection.index)
      : rest;

    const parsed = parseSection(sectionText, section);
    log('fetch', 'info', `  ${section}: ${parsed.length} total rows`);
    allRows.push(...parsed);
  }

  log('fetch', 'info', `Total rows across all sections: ${allRows.length}`);

  // Filter to only "0d" (today's) jobs — already newest-first (top of table)
  const todayRows = allRows.filter((r) => r.age === '0d');
  log('fetch', 'info', `Jobs posted today (0d): ${todayRows.length}`);

  const from = range ? range.from : 1;
  const to = range ? range.to : todayRows.length;
  const sliced = todayRows.slice(from - 1, to);
  log('fetch', 'info', `Taking jobs ${from}–${to} (newest first) out of ${todayRows.length} today`);

  if (sliced.length === 0) {
    log('fetch', 'warn', 'No jobs in selected range. Saving empty list.');
  }

  const jobs: RawJob[] = sliced.map((row, idx) => {
    const job: RawJob = {
      id: crypto.randomUUID(),
      positionTitle: row.role || 'Unknown Position',
      company: row.company || 'Unknown Company',
      location: row.location || null,
      applyLink: row.applyLink,
      datePosted: new Date().toISOString().split('T')[0],
      salary: null,
      rawFields: {
        category: row.category,
        age: row.age,
        source: 'github',
      },
    };

    log('fetch', 'info', `  [${idx + 1}] ${job.company} — ${job.positionTitle} (${row.category})`);
    return job;
  });

  writeStep('step1-raw-jobs', jobs);
  log('fetch', 'info', `Step 1 complete: ${jobs.length} jobs saved (source: GitHub)`);
  return jobs.length;
}
