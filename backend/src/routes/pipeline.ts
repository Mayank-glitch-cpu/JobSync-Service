import type { FastifyInstance } from 'fastify';
import { log } from '../logger.js';
import { clearAll } from '../store.js';
import { fetchCsv } from '../services/csv-fetcher.js';
import { fetchGitHub } from '../services/github-fetcher.js';
import { fetchYC } from '../services/yc-fetcher.js';
import { fetchJSearch } from '../services/jsearch-fetcher.js';
import { fetchTheirStack } from '../services/theirstack-fetcher.js';
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
    const limit = !isNaN(limitVal) ? limitVal : 10;

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

    if (source === 'github') {
      runStep('step1', 'Step 1 (Fetch GitHub)', () => fetchGitHub(range));
    } else if (source === 'yc') {
      runStep('step1', 'Step 1 (Fetch YC)', () => fetchYC(range));
    } else if (source === 'jsearch') {
      runStep('step1', 'Step 1 (Fetch JSearch)', () => fetchJSearch(range));
    } else if (source === 'theirstack') {
      runStep('step1', 'Step 1 (Fetch TheirStack/Ashby)', () =>
        fetchTheirStack({
          range,
          limit,
          companySlugs: companies,
          keywords,
          postedTodayOnly,
          publishedWithinHours,
        })
      );
    } else {
      runStep('step1', 'Step 1 (Fetch CSV)', () => fetchCsv(limit));
    }

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
