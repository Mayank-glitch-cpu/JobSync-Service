import type { FastifyInstance } from 'fastify';
import { log } from '../logger.js';
import { clearAll } from '../store.js';
import { fetchCsv } from '../services/csv-fetcher.js';
import { fetchGitHub } from '../services/github-fetcher.js';
import { fetchYC } from '../services/yc-fetcher.js';
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

export async function pipelineRoutes(app: FastifyInstance): Promise<void> {
  // Trigger Step 1: Fetch Jobs (CSV or GitHub)
  app.post<{ Querystring: { source?: string; from?: string; to?: string } }>(
    '/api/pipeline/step1',
    async (request, reply) => {
      if (pipelineStatus.step1.status === 'running') {
        return reply.status(409).send({ error: 'Step 1 is already running' });
      }
      const source = request.query.source || 'csv';
      const fromVal = parseInt(request.query.from || '', 10);
      const toVal = parseInt(request.query.to || '', 10);
      const range = !isNaN(fromVal) && !isNaN(toVal) ? { from: fromVal, to: toVal } : undefined;

      if (source === 'github') {
        runStep('step1', 'Step 1 (Fetch GitHub)', () => fetchGitHub(range));
      } else if (source === 'yc') {
        runStep('step1', 'Step 1 (Fetch YC)', () => fetchYC(range));
      } else {
        runStep('step1', 'Step 1 (Fetch CSV)', () => fetchCsv(range));
      }
      return reply.send({ status: 'started', step: 1, source });
    }
  );

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
