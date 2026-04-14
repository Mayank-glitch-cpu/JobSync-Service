import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StepName } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(__dirname, '..', 'data');

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function filePath(step: StepName): string {
  return path.join(DATA_DIR, `${step}.json`);
}

export function readStep<T>(step: StepName): T | null {
  ensureDataDir();
  const fp = filePath(step);
  if (!fs.existsSync(fp)) return null;
  const raw = fs.readFileSync(fp, 'utf-8');
  return JSON.parse(raw) as T;
}

export function writeStep<T>(step: StepName, data: T): void {
  ensureDataDir();
  fs.writeFileSync(filePath(step), JSON.stringify(data, null, 2), 'utf-8');
}

export function clearAll(): void {
  ensureDataDir();
  const files = fs.readdirSync(DATA_DIR);
  for (const file of files) {
    if (file.endsWith('.json')) {
      fs.unlinkSync(path.join(DATA_DIR, file));
    }
  }
}
