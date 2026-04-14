import type { FastifyInstance } from 'fastify';
import { addClient, removeClient, getLogHistory } from '../logger.js';

export async function logsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/logs/stream', async (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    // Send buffered history
    for (const entry of getLogHistory()) {
      reply.raw.write(`data: ${JSON.stringify(entry)}\n\n`);
    }

    addClient(reply);

    request.raw.on('close', () => {
      removeClient(reply);
    });

    // Keep connection open — do not call reply.send()
  });
}
