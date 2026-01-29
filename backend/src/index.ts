import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.js';
import { log } from './logger.js';
import { pipelineRoutes } from './routes/pipeline.js';
import { dataRoutes } from './routes/data.js';
import { logsRoutes } from './routes/logs.js';

const app = Fastify({ logger: false });

await app.register(cors, { origin: true });

// Register routes
await app.register(pipelineRoutes);
await app.register(dataRoutes);
await app.register(logsRoutes);

// Health check
app.get('/api/health', async () => ({ status: 'ok' }));

// Start server
try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
  log('system', 'info', `Backend running on http://localhost:${config.port}`);
} catch (err) {
  console.error('Failed to start server:', err);
  process.exit(1);
}
