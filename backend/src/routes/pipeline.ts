import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { log } from '../logger.js';
import { clearAll } from '../store.js';
import { fetchCsv } from '../services/csv-fetcher.js';
import { fetchGitHub } from '../services/github-fetcher.js';
import { fetchYC } from '../services/yc-fetcher.js';
import { fetchJSearch } from '../services/jsearch-fetcher.js';
import { fetchTheirStack } from '../services/theirstack-fetcher.js';
import { fetchRemotive } from '../services/remotive-fetcher.js';
import { fetchRemoteOK } from '../services/remoteok-fetcher.js';
import { fetchAdzuna } from '../services/adzuna-fetcher.js';
import { fetchHN } from '../services/hn-fetcher.js';
import { fetchArbeitnow } from '../services/arbeitnow-fetcher.js';
import { fetchUSAJobs } from '../services/usajobs-fetcher.js';
import { fetchGreenhouse } from '../services/greenhouse-fetcher.js';
import { fetchLever } from '../services/lever-fetcher.js';
import { fetchLinkedIn } from '../services/linkedin-fetcher.js';
import { fetchWellfound } from '../services/wellfound-fetcher.js';
import { fetchHimalayas } from '../services/himalayas-fetcher.js';
import { fetchJobicy } from '../services/jobicy-fetcher.js';
import { fetchAshbyGoogle } from '../services/ashby-google-fetcher.js';
import { fetchSmartRecruiters } from '../services/smartrecruiters-fetcher.js';
import { fetchWorkday } from '../services/workday-fetcher.js';
import { fetchRecruitee } from '../services/recruitee-fetcher.js';
import { fetchWorkable } from '../services/workable-fetcher.js';
import { fetchMultiSource } from '../services/multi-source-fetcher.js';
import { scrapeJDs } from '../services/jd-scraper.js';
import { processWithAI } from '../services/ai-processor.js';
import { syncToAirtable } from '../services/airtable-sync.js';
import type { PipelineStatus, StepStatus } from '../types.js';

const defaultStep = (): StepStatus => ({
  status: 'idle',
  lastRun: null,
  jobCount: 0,
});

export const pipelineStatus: PipelineStatus = {
  step1: defaultStep(),
  step2: defaultStep(),
  step3: defaultStep(),
  step4: defaultStep(),
};

function runStep(
  stepKey: keyof PipelineStatus,
  stepLabel: string,
  fn: () => Promise<number>
): void {
  const step = pipelineStatus[stepKey];
  step.status = 'running';
  step.error = undefined;
  step.lastRun = new Date().toISOString();

  fn()
    .then((count) => {
      step.status = 'completed';
      step.jobCount = count;
      log('system', 'info', `${stepLabel} completed: ${count} jobs`);
    })
    .catch((err: Error) => {
      step.status = 'error';
      step.error = err.message;
      log('system', 'error', `${stepLabel} failed: ${err.message}`);
    });
}

function parseCommaList(value?: string): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseBoolean(value?: string): boolean {
  if (!value) {
    return false;
  }

  return ['1', 'true', 'yes', 'y'].includes(value.toLowerCase());
}

/**
 * Resolve a source string to a step1 label + fetcher function.
 */
function resolveSource(
  source: string,
  options: {
    range?: { from: number; to: number };
    limit?: number;
    keywords?: string[];
    companySlugs?: string[];
    publishedWithinHours?: number;
    postedTodayOnly?: boolean;
  }
): { label: string; fn: () => Promise<number> } {
  const limit = options.limit ?? 20;

  switch (source) {
    case 'csv':
      return { label: 'Step 1 (Fetch Google Sheets)', fn: () => fetchCsv(options.limit) };
    case 'github':
      return { label: 'Step 1 (Fetch GitHub)', fn: () => fetchGitHub(options.range) };
    case 'yc':
      return { label: 'Step 1 (Fetch YC)', fn: () => fetchYC(options.range) };
    case 'jsearch':
      return { label: 'Step 1 (Fetch JSearch)', fn: () => fetchJSearch(options.range) };
    case 'remotive':
      return { label: 'Step 1 (Fetch Remotive)', fn: () => fetchRemotive({ limit }) };
    case 'remoteok':
      return { label: 'Step 1 (Fetch RemoteOK)', fn: () => fetchRemoteOK({ limit, tags: ['engineer', 'developer', 'data', 'ml', 'robotics', 'ui', 'ux', 'ai'] }) };
    case 'adzuna':
      return { label: 'Step 1 (Fetch Adzuna)', fn: () => fetchAdzuna({ limit }) };
    case 'hackernews':
      return { label: 'Step 1 (Fetch HackerNews)', fn: () => fetchHN({ limit, keywords: ['engineer', 'ml', 'ai', 'data', 'backend', 'fullstack', 'robotics', 'ui', 'ux'] }) };
    case 'arbeitnow':
      return { label: 'Step 1 (Fetch Arbeitnow)', fn: () => fetchArbeitnow({ limit, keywords: ['engineer', 'developer', 'data', 'machine learning', 'robotics', 'ui', 'ux', 'ai'] }) };
    case 'usajobs':
      return { label: 'Step 1 (Fetch USAJobs)', fn: () => fetchUSAJobs({ limit }) };
    case 'greenhouse':
      return { label: 'Step 1 (Fetch Greenhouse)', fn: () => fetchGreenhouse({ limit, maxAgeDays: 3 }) };
    case 'lever':
      return { label: 'Step 1 (Fetch Lever)', fn: () => fetchLever({ limit, maxAgeDays: 7 }) };
    case 'linkedin':
      return { label: 'Step 1 (Fetch LinkedIn)', fn: () => fetchLinkedIn({ limit, datePosted: 'pastWeek' }) };
    case 'wellfound':
      return { label: 'Step 1 (Fetch Wellfound)', fn: () => fetchWellfound({ limit }) };
    case 'himalayas':
      return { label: 'Step 1 (Fetch Himalayas)', fn: () => fetchHimalayas({ limit }) };
    case 'jobicy':
      return { label: 'Step 1 (Fetch Jobicy)', fn: () => fetchJobicy({ limit }) };
    case 'ashby-google':
      return { label: 'Step 1 (Fetch Ashby Google)', fn: () => fetchAshbyGoogle({ limit, maxAgeDays: 7 }) };
    case 'smartrecruiters':
      return { label: 'Step 1 (Fetch SmartRecruiters)', fn: () => fetchSmartRecruiters({ limit, maxAgeDays: 7 }) };
    case 'workday':
      return { label: 'Step 1 (Fetch Workday)', fn: () => fetchWorkday({ limit, maxAgeDays: 7 }) };
    case 'recruitee':
      return { label: 'Step 1 (Fetch Recruitee)', fn: () => fetchRecruitee({ limit, maxAgeDays: 14 }) };
    case 'workable':
      return { label: 'Step 1 (Fetch Workable)', fn: () => fetchWorkable({ limit, maxAgeDays: 7 }) };
    case 'multi':
    case 'all':
      return { label: 'Step 1 (Fetch All Sources)', fn: () => fetchMultiSource() };
    case 'free':
      return {
        label: 'Step 1 (Fetch Free Sources)',
        fn: () => fetchMultiSource({
          sources: ['csv', 'github', 'ashby', 'remotive', 'remoteok', 'hackernews', 'arbeitnow', 'greenhouse', 'lever', 'wellfound', 'himalayas', 'jobicy', 'smartrecruiters', 'workday', 'recruitee', 'workable'],
        }),
      };
    case 'premium':
      return {
        label: 'Step 1 (Fetch Premium Sources)',
        fn: () => fetchMultiSource({
          sources: ['jsearch', 'yc', 'linkedin', 'adzuna', 'usajobs'],
        }),
      };
    default:
      // Default to Ashby/TheirStack
      return {
        label: 'Step 1 (Fetch Ashby)',
        fn: () => fetchTheirStack({
          limit: options.limit,
          keywords: options.keywords,
          companySlugs: options.companySlugs,
          publishedWithinHours: options.publishedWithinHours,
          postedTodayOnly: options.postedTodayOnly,
        }),
      };
  }
}

interface FullPipelineOptions {
  source?: string;
  limit?: number;
  keywords?: string[];
  companySlugs?: string[];
  publishedWithinHours?: number;
  postedTodayOnly?: boolean;
}

async function runFullPipeline(options: FullPipelineOptions): Promise<void> {
  const source = options.source || 'theirstack';
  const range = options.limit ? { from: 1, to: options.limit } : undefined;

  const resolved = resolveSource(source, { range, ...options });

  const steps: Array<{
    key: keyof PipelineStatus;
    label: string;
    fn: () => Promise<number>;
  }> = [
    { key: 'step1', label: resolved.label, fn: resolved.fn },
    { key: 'step2', label: 'Step 2 (Scrape JDs)', fn: scrapeJDs },
    { key: 'step3', label: 'Step 3 (AI Process)', fn: processWithAI },
    { key: 'step4', label: 'Step 4 (Airtable Sync)', fn: syncToAirtable },
  ];

  // Reset all steps so polling doesn't see stale "completed" from a previous run
  for (const { key } of steps) {
    pipelineStatus[key].status = 'pending';
    pipelineStatus[key].error = undefined;
    pipelineStatus[key].jobCount = 0;
  }

  log('system', 'info', 'Full pipeline: Starting all 4 steps sequentially...');

  for (const { key, label, fn } of steps) {
    const step = pipelineStatus[key];
    step.status = 'running';
    step.error = undefined;
    step.lastRun = new Date().toISOString();

    log('system', 'info', `Full pipeline: Starting ${label}...`);

    try {
      const count = await fn();
      step.status = 'completed';
      step.jobCount = count;
      log('system', 'info', `Full pipeline: ${label} completed — ${count} jobs`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      step.status = 'error';
      step.error = message;
      log('system', 'error', `Full pipeline: ${label} failed — ${message}`);
      throw new Error(`Pipeline failed at ${label}: ${message}`);
    }
  }

  log('system', 'info', 'Full pipeline: All 4 steps completed successfully');
}

export async function pipelineRoutes(app: FastifyInstance): Promise<void> {
  app.post<{
    Querystring: {
      source?: string;
      from?: string;
      to?: string;
      limit?: string;
      companies?: string;
      keywords?: string;
      postedToday?: string;
      publishedWithinHours?: string;
    };
  }>('/api/pipeline/step1', async (request, reply) => {
    if (pipelineStatus.step1.status === 'running') {
      return reply.status(409).send({ error: 'Step 1 is already running' });
    }

    const source = request.query.source || 'csv';
    const fromVal = parseInt(request.query.from || '', 10);
    const toVal = parseInt(request.query.to || '', 10);
    const limitVal = parseInt(request.query.limit || '', 10);
    const publishedWithinHoursVal = parseInt(request.query.publishedWithinHours || '', 10);
    const range = !isNaN(fromVal) && !isNaN(toVal) ? { from: fromVal, to: toVal } : undefined;
    const limit = !isNaN(limitVal) ? limitVal : range ? range.to : 10;

    const companies = parseCommaList(request.query.companies).map((slug) => slug.toLowerCase());
    const keywords = parseCommaList(request.query.keywords).map((keyword) => keyword.toLowerCase());
    const postedTodayOnly = parseBoolean(request.query.postedToday);
    const publishedWithinHours = !isNaN(publishedWithinHoursVal)
      ? publishedWithinHoursVal
      : undefined;

    log(
      'system',
      'info',
      `Step 1 params: source=${source}, range=${JSON.stringify(range)}, limit=${limit}, companies=${companies.join('|') || 'all'}, keywords=${keywords.join('|') || 'default'}, postedToday=${postedTodayOnly}, publishedWithinHours=${publishedWithinHours ?? 'default'}`
    );

    const resolved = resolveSource(source, { range, limit, keywords, companySlugs: companies, postedTodayOnly, publishedWithinHours });
    runStep('step1', resolved.label, resolved.fn);

    return reply.send({
      status: 'started',
      step: 1,
      source,
      filters:
        source === 'theirstack'
          ? {
              companies,
              keywords,
              postedToday: postedTodayOnly,
              publishedWithinHours,
              limit,
            }
          : undefined,
    });
  });

  // Trigger Step 2: Scrape JDs
  app.post('/api/pipeline/step2', async (_request, reply) => {
    if (pipelineStatus.step2.status === 'running') {
      return reply.status(409).send({ error: 'Step 2 is already running' });
    }
    runStep('step2', 'Step 2 (Scrape JDs)', scrapeJDs);
    return reply.send({ status: 'started', step: 2 });
  });

  // Trigger Step 3: AI Process
  app.post('/api/pipeline/step3', async (_request, reply) => {
    if (pipelineStatus.step3.status === 'running') {
      return reply.status(409).send({ error: 'Step 3 is already running' });
    }
    runStep('step3', 'Step 3 (AI Process)', processWithAI);
    return reply.send({ status: 'started', step: 3 });
  });

  // Trigger Step 4: Airtable Sync
  app.post('/api/pipeline/step4', async (_request, reply) => {
    if (pipelineStatus.step4.status === 'running') {
      return reply.status(409).send({ error: 'Step 4 is already running' });
    }
    runStep('step4', 'Step 4 (Airtable Sync)', syncToAirtable);
    return reply.send({ status: 'started', step: 4 });
  });

  // Trigger full pipeline (all 4 steps sequentially)
  app.post<{
    Querystring: {
      source?: string;
      limit?: string;
      keywords?: string;
      companies?: string;
      publishedWithinHours?: string;
      postedToday?: string;
    };
  }>('/api/pipeline/run-all', async (request, reply) => {
    // Optional API key authentication
    const apiKey = request.headers['x-api-key'] as string | undefined;
    if (config.pipelineApiKey && apiKey !== config.pipelineApiKey) {
      return reply.status(401).send({ error: 'Invalid API key' });
    }

    // Check if any step is currently running
    const anyRunning = Object.values(pipelineStatus).some((s) => s.status === 'running');
    if (anyRunning) {
      return reply.status(409).send({ error: 'Pipeline is already running' });
    }

    const source = request.query.source || 'theirstack';
    const limitVal = parseInt(request.query.limit || '', 10);
    const publishedWithinHoursVal = parseInt(request.query.publishedWithinHours || '', 10);
    const companies = parseCommaList(request.query.companies).map((slug) => slug.toLowerCase());
    const keywords = parseCommaList(request.query.keywords).map((keyword) => keyword.toLowerCase());
    const postedTodayOnly = parseBoolean(request.query.postedToday);

    log('system', 'info', `Full pipeline triggered: source=${source}, limit=${!isNaN(limitVal) ? limitVal : 'default'}`);

    // Run the full pipeline in the background
    runFullPipeline({
      source,
      limit: !isNaN(limitVal) ? limitVal : undefined,
      keywords: keywords.length > 0 ? keywords : undefined,
      companySlugs: companies.length > 0 ? companies : undefined,
      publishedWithinHours: !isNaN(publishedWithinHoursVal) ? publishedWithinHoursVal : undefined,
      postedTodayOnly,
    }).catch((err: Error) => {
      log('system', 'error', `Full pipeline failed: ${err.message}`);
    });

    return reply.send({ status: 'started', source, message: `Full pipeline running for source: ${source}` });
  });

  // Get pipeline status
  app.get('/api/pipeline/status', async (_request, reply) => {
    return reply.send(pipelineStatus);
  });

  // Reset all data
  app.post('/api/pipeline/reset', async (_request, reply) => {
    clearAll();
    pipelineStatus.step1 = defaultStep();
    pipelineStatus.step2 = defaultStep();
    pipelineStatus.step3 = defaultStep();
    pipelineStatus.step4 = defaultStep();
    log('system', 'info', 'Pipeline reset — all data cleared');
    return reply.send({ status: 'reset' });
  });
}
