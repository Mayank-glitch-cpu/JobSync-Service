import { parse } from 'csv-parse/sync';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { log } from '../logger.js';
import { writeStep } from '../store.js';
import type { RawJob } from '../types.js';

// Mapping of common column header variations to our field names
const HEADER_MAP: Record<string, keyof RawJob> = {
  company: 'company',
  company_name: 'company',
  'company name': 'company',

  position: 'positionTitle',
  title: 'positionTitle',
  role: 'positionTitle',
  'position title': 'positionTitle',
  'job title': 'positionTitle',
  'job tittle': 'positionTitle',

  location: 'location',
  locations: 'location',
  'job location': 'location',

  link: 'applyLink',
  url: 'applyLink',
  'apply link': 'applyLink',
  apply: 'applyLink',
  application: 'applyLink',
  'application link': 'applyLink',
  'apply url': 'applyLink',
  'job link': 'applyLink',

  date: 'datePosted',
  'date posted': 'datePosted',
  posted: 'datePosted',
  'date added': 'datePosted',

  salary: 'salary',
  compensation: 'salary',
  pay: 'salary',
};

function mapHeaders(headers: string[]): Map<number, keyof RawJob> {
  const mapping = new Map<number, keyof RawJob>();
  for (let i = 0; i < headers.length; i++) {
    const normalized = headers[i].trim().toLowerCase();
    const field = HEADER_MAP[normalized];
    if (field) {
      mapping.set(i, field);
    }
  }
  return mapping;
}

export async function fetchCsv(range?: { from: number; to: number }): Promise<number> {
  log('fetch', 'info', 'Fetching CSV from Google Sheets...');
  log('fetch', 'debug', `URL: ${config.googleSheetsCsvUrl}`);

  const response = await fetch(config.googleSheetsCsvUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch CSV: ${response.status} ${response.statusText}`);
  }

  const csvText = await response.text();
  log('fetch', 'info', `Received CSV data (${csvText.length} bytes)`);

  // Parse CSV
  const records: string[][] = parse(csvText, {
    relax_column_count: true,
    skip_empty_lines: true,
  });

  if (records.length < 2) {
    throw new Error('CSV has no data rows (only headers or empty)');
  }

  // Find the actual header row by looking for a row that maps to at least 2 known fields
  let headerRowIndex = 0;
  let headerMapping = new Map<number, keyof RawJob>();
  for (let i = 0; i < records.length; i++) {
    const candidate = mapHeaders(records[i]);
    if (candidate.size >= 2) {
      headerRowIndex = i;
      headerMapping = candidate;
      break;
    }
  }

  const headers = records[headerRowIndex];
  log('fetch', 'info', `Found header row at line ${headerRowIndex + 1}: ${headers.join(', ')}`);
  log('fetch', 'info', `Found ${records.length - headerRowIndex - 1} data rows`);

  log(
    'fetch',
    'info',
    `Mapped columns: ${[...headerMapping.entries()].map(([i, f]) => `${headers[i]} -> ${f}`).join(', ')}`
  );

  // All data rows, newest last (bottom of sheet = newest)
  const dataRows = records.slice(headerRowIndex + 1);
  // Reverse so index 0 = newest
  const newestFirst = [...dataRows].reverse();
  const total = newestFirst.length;

  const from = range ? range.from : 1;
  const to = range ? range.to : config.jobCount;
  const sliced = newestFirst.slice(from - 1, to);
  log('fetch', 'info', `Taking jobs ${from}–${to} (newest first) out of ${total} total`);

  const jobs: RawJob[] = sliced.map((row: string[], idx: number) => {
    const rawFields: Record<string, string> = {};
    const job: RawJob = {
      id: crypto.randomUUID(),
      positionTitle: '',
      company: '',
      location: null,
      applyLink: null,
      datePosted: null,
      salary: null,
      rawFields: {},
    };

    for (let i = 0; i < row.length; i++) {
      const value = row[i]?.trim() || '';
      const headerName = headers[i]?.trim() || `column_${i}`;
      rawFields[headerName] = value;

      const field = headerMapping.get(i);
      if (field && field !== 'id' && field !== 'rawFields') {
        (job as unknown as Record<string, unknown>)[field] = value || null;
      }
    }

    job.rawFields = rawFields;
    if (!job.positionTitle) job.positionTitle = 'Unknown Position';
    if (!job.company) job.company = 'Unknown Company';

    log('fetch', 'info', `  [${idx + 1}] ${job.company} — ${job.positionTitle}`);
    return job;
  });

  writeStep('step1-raw-jobs', jobs);
  log('fetch', 'info', `Step 1 complete: ${jobs.length} jobs saved`);
  return jobs.length;
}
