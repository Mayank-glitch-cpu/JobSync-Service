import crypto from 'node:crypto';
import { log } from '../logger.js';
import { writeStep } from '../store.js';
import type { RawJob } from '../types.js';

// HN Algolia API for searching "Who is Hiring" threads
const HN_SEARCH_URL = 'https://hn.algolia.com/api/v1/search';
const HN_ITEM_URL = 'https://hn.algolia.com/api/v1/items';

interface HNSearchHit {
  objectID: string;
  title: string;
  created_at: string;
  num_comments: number;
}

interface HNComment {
  id: number;
  author: string | null;
  text: string | null;
  created_at: string;
  children: HNComment[];
}

interface HNItem {
  id: number;
  title: string;
  children: HNComment[];
}

interface ParsedPosting {
  company: string;
  title: string;
  location: string | null;
  applyLink: string | null;
  salary: string | null;
  remote: boolean;
  rawText: string;
  datePosted: string;
}

/**
 * Parse a top-level comment from "Who is Hiring" thread.
 * Format is typically: Company Name | Role | Location | Remote | Salary
 * followed by description in the body.
 */
function parseHNPosting(comment: HNComment): ParsedPosting | null {
  if (!comment.text || comment.text.length < 30) return null;

  // Strip HTML tags
  const text = comment.text
    .replace(/<[^>]+>/g, '\n')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .trim();

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;

  // First line is usually: Company | Role | Location | ...
  const headerLine = lines[0];
  const parts = headerLine.split('|').map((p) => p.trim());

  if (parts.length < 2) {
    // Try to still extract if it's a single company name followed by description
    return null;
  }

  const company = parts[0] || 'Unknown Company';
  const title = parts[1] || 'Unknown Position';
  const locationParts = parts.slice(2).filter(
    (p) => !/remote|onsite|hybrid|salary|\$|http/i.test(p)
  );
  const location = locationParts.join(', ') || null;

  const remote = parts.some((p) => /remote/i.test(p));

  // Extract URLs from body
  const urlMatch = text.match(/https?:\/\/[^\s<>"]+/);
  const applyLink = urlMatch ? urlMatch[0] : null;

  // Extract salary patterns
  const salaryMatch = text.match(
    /\$[\d,]+(?:\s*[-–]\s*\$[\d,]+)?(?:\s*\/?\s*(?:yr|year|annually|hr|hour))?/i
  );
  const salary = salaryMatch ? salaryMatch[0] : null;

  return {
    company,
    title,
    location: remote && !location ? 'Remote' : location,
    applyLink,
    salary,
    remote,
    rawText: text.slice(0, 3000),
    datePosted: comment.created_at?.split('T')[0] || new Date().toISOString().split('T')[0],
  };
}

export interface FetchHNOptions {
  range?: { from: number; to: number };
  limit?: number;
  keywords?: string[];
  /** Which monthly thread to use (0 = most recent, 1 = previous month, etc.) */
  monthOffset?: number;
}

export async function fetchHN(options: FetchHNOptions = {}): Promise<number> {
  const monthOffset = options.monthOffset ?? 0;
  const keywords = (options.keywords ?? []).map((k) => k.toLowerCase());

  log('fetch', 'info', 'Fetching jobs from Hacker News "Who is Hiring" thread...');

  // Step 1: Find the most recent "Who is Hiring" thread
  const searchParams = new URLSearchParams({
    query: '"Ask HN: Who is hiring"',
    tags: 'story,author_whoishiring',
    hitsPerPage: '5',
  });

  const searchResponse = await fetch(`${HN_SEARCH_URL}?${searchParams}`, {
    headers: { Accept: 'application/json' },
  });

  if (!searchResponse.ok) {
    throw new Error(`HN Search API failed: ${searchResponse.status}`);
  }

  const searchResult = await searchResponse.json();
  const hits: HNSearchHit[] = searchResult.hits || [];

  if (hits.length === 0) {
    throw new Error('Could not find any "Who is Hiring" threads on HN');
  }

  // Sort by date descending, pick the one at monthOffset
  hits.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const targetThread = hits[Math.min(monthOffset, hits.length - 1)];

  log('fetch', 'info', `Using thread: "${targetThread.title}" (${targetThread.num_comments} comments)`);

  // Step 2: Fetch the thread's top-level comments
  const itemResponse = await fetch(`${HN_ITEM_URL}/${targetThread.objectID}`, {
    headers: { Accept: 'application/json' },
  });

  if (!itemResponse.ok) {
    throw new Error(`HN Item API failed: ${itemResponse.status}`);
  }

  const thread: HNItem = await itemResponse.json();
  const topLevelComments = thread.children || [];

  log('fetch', 'info', `Thread has ${topLevelComments.length} top-level comments`);

  // Step 3: Parse each top-level comment as a job posting
  const parsed: ParsedPosting[] = [];
  for (const comment of topLevelComments) {
    const posting = parseHNPosting(comment);
    if (posting) parsed.push(posting);
  }

  log('fetch', 'info', `Parsed ${parsed.length} valid job postings`);

  // Step 4: Keyword filtering (if provided)
  const filtered = keywords.length > 0
    ? parsed.filter((p) => {
        const hay = `${p.company} ${p.title} ${p.rawText}`.toLowerCase();
        return keywords.some((kw) => hay.includes(kw));
      })
    : parsed;

  log('fetch', 'info', `${filtered.length} jobs after keyword filter`);

  const from = options.range ? options.range.from : 1;
  const to = options.range ? options.range.to : Math.min(filtered.length, options.limit ?? 30);
  const sliced = filtered.slice(from - 1, to);

  log('fetch', 'info', `Taking jobs ${from}–${to} out of ${filtered.length} total`);

  const jobs: RawJob[] = sliced.map((item, idx) => {
    const job: RawJob = {
      id: crypto.randomUUID(),
      positionTitle: item.title || 'Unknown Position',
      company: item.company || 'Unknown Company',
      location: item.location,
      applyLink: item.applyLink,
      datePosted: item.datePosted,
      salary: item.salary,
      rawFields: {
        source: 'hackernews',
        hnThreadId: targetThread.objectID,
        remote: String(item.remote),
        description: item.rawText,
      },
    };

    log('fetch', 'info', `  [${idx + 1}] ${job.company} — ${job.positionTitle}`);
    return job;
  });

  writeStep('step1-raw-jobs', jobs);
  log('fetch', 'info', `Step 1 complete: ${jobs.length} jobs saved (source: HackerNews)`);
  return jobs.length;
}
