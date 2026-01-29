import type { FastifyReply } from 'fastify';
import type { LogEntry } from './types.js';

type LogLevel = LogEntry['level'];
type LogStep = LogEntry['step'];

const clients = new Set<FastifyReply>();
const history: LogEntry[] = [];
const MAX_HISTORY = 500;

export function addClient(reply: FastifyReply): void {
  clients.add(reply);
}

export function removeClient(reply: FastifyReply): void {
  clients.delete(reply);
}

export function getLogHistory(): LogEntry[] {
  return [...history];
}

export function log(
  step: LogStep,
  level: LogLevel,
  message: string,
  data?: unknown
): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    step,
    message,
    ...(data !== undefined && { data }),
  };

  // Buffer in memory
  history.push(entry);
  if (history.length > MAX_HISTORY) {
    history.shift();
  }

  // Console output
  const prefix = `[${entry.step}]`;
  if (level === 'error') {
    console.error(prefix, message, data ?? '');
  } else if (level === 'warn') {
    console.warn(prefix, message, data ?? '');
  } else {
    console.log(prefix, message, data ?? '');
  }

  // Broadcast to SSE clients
  const payload = `data: ${JSON.stringify(entry)}\n\n`;
  for (const client of clients) {
    try {
      client.raw.write(payload);
    } catch {
      clients.delete(client);
    }
  }
}
