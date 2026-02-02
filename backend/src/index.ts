import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { log } from './logger.js';
import { pipelineRoutes } from './routes/pipeline.js';
import { dataRoutes } from './routes/data.js';
import { logsRoutes } from './routes/logs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = Fastify({ logger: false });

await app.register(cors, { origin: true });

// Register API routes
await app.register(pipelineRoutes);
await app.register(dataRoutes);
await app.register(logsRoutes);

// Health check
app.get('/api/health', async () => ({ status: 'ok' }));

// In production, serve the frontend static build
const frontendDist = path.resolve(__dirname, '../../frontend/dist');
await app.register(fastifyStatic, {
  root: frontendDist,
  wildcard: false,
});

// SPA fallback: serve index.html for any non-API route
app.setNotFoundHandler((_request, reply) => {
  reply.sendFile('index.html');
});

// Start server
try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
  log('system', 'info', `Server running on http://localhost:${config.port}`);
} catch (err) {
  console.error('Failed to start server:', err);
  process.exit(1);
}
