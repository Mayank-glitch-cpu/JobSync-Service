import type { FastifyInstance } from 'fastify';
import { readStep } from '../store.js';
import type { StepName } from '../types.js';

const STEP_MAP: Record<string, StepName> = {
  '1': 'step1-raw-jobs',
  '2': 'step2-scraped-jobs',
  '3': 'step3-processed-jobs',
  '4': 'step4-synced-jobs',
};

export async function dataRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { step: string } }>(
    '/api/data/:step',
    async (request, reply) => {
      const stepName = STEP_MAP[request.params.step];
      if (!stepName) {
        return reply.status(400).send({ error: 'Invalid step. Use 1-4.' });
      }

      const data = readStep(stepName);
      if (data === null) {
        return reply.send({ jobs: [], message: 'No data yet. Run this step first.' });
      }
      return reply.send({ jobs: data });
    }
  );
}
