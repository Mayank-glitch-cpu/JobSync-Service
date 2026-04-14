// Hybrid dedup: local SQLite cache of seen job URLs. The MCP tool layer
// falls back to airtable_list_recent_jobs on a miss — this module only
// handles the local half.
//
// Uses the built-in node:sqlite module (stable in Node 22.5+ / Node 24) to
// avoid a native-compile dependency on the user's machine.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CACHE_DB_PATH } from "../config.js";

// Dynamic import to preserve `node:` prefix through the esbuild bundler,
// which otherwise strips it and breaks Node's module resolution for builtins.
type DatabaseSyncCtor = new (path: string) => {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number | bigint };
    all(...params: unknown[]): unknown[];
  };
};

let DatabaseSyncPromise: Promise<DatabaseSyncCtor> | null = null;
function loadDatabaseSync(): Promise<DatabaseSyncCtor> {
  if (!DatabaseSyncPromise) {
    // Obscure the module name from esbuild's static analyzer so it doesn't
    // strip the required `node:` prefix. Node needs the prefix to resolve
    // the built-in sqlite module at runtime.
    const moduleName = ["node", "sqlite"].join(":");
    DatabaseSyncPromise = import(moduleName).then(
      (m) => (m as { DatabaseSync: DatabaseSyncCtor }).DatabaseSync,
    );
  }
  return DatabaseSyncPromise;
}

export interface SeenJob {
  urlHash: string;
  applyLink: string;
  company: string;
  positionTitle: string;
  seenAt: string;
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    u.search = "";
    return u.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

export function hashUrl(url: string): string {
  return createHash("sha256").update(normalizeUrl(url)).digest("hex").slice(0, 32);
}

type Db = InstanceType<DatabaseSyncCtor>;
let db: Db | null = null;

export async function getDb(): Promise<Db> {
  if (db) return db;
  const dir = dirname(CACHE_DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const DatabaseSync = await loadDatabaseSync();
  db = new DatabaseSync(CACHE_DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS seen_jobs (
      url_hash TEXT PRIMARY KEY,
      apply_link TEXT NOT NULL,
      company TEXT NOT NULL,
      position_title TEXT NOT NULL,
      seen_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_seen_at ON seen_jobs(seen_at);
  `);
  return db;
}

export async function isSeen(applyLink: string): Promise<SeenJob | null> {
  const hash = hashUrl(applyLink);
  const row = (await getDb())
    .prepare(
      "SELECT url_hash AS urlHash, apply_link AS applyLink, company, position_title AS positionTitle, seen_at AS seenAt FROM seen_jobs WHERE url_hash = ?",
    )
    .get(hash) as SeenJob | undefined;
  return row ?? null;
}

export async function markSeen(job: {
  applyLink: string;
  company: string;
  positionTitle: string;
}): Promise<void> {
  const hash = hashUrl(job.applyLink);
  (await getDb())
    .prepare(
      "INSERT OR REPLACE INTO seen_jobs (url_hash, apply_link, company, position_title, seen_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(hash, job.applyLink, job.company, job.positionTitle, new Date().toISOString());
}

export async function markSeenBatch(
  jobs: Array<{ applyLink: string; company: string; positionTitle: string }>,
): Promise<number> {
  const database = await getDb();
  const stmt = database.prepare(
    "INSERT OR REPLACE INTO seen_jobs (url_hash, apply_link, company, position_title, seen_at) VALUES (?, ?, ?, ?, ?)",
  );
  const now = new Date().toISOString();
  database.exec("BEGIN");
  try {
    for (const r of jobs) {
      stmt.run(hashUrl(r.applyLink), r.applyLink, r.company, r.positionTitle, now);
    }
    database.exec("COMMIT");
  } catch (err) {
    database.exec("ROLLBACK");
    throw err;
  }
  return jobs.length;
}

export async function pruneOlderThan(days: number): Promise<number> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const result = (await getDb())
    .prepare("DELETE FROM seen_jobs WHERE seen_at < ?")
    .run(cutoff);
  return Number(result.changes);
}

export async function cacheSize(): Promise<number> {
  const row = (await getDb())
    .prepare("SELECT COUNT(*) AS n FROM seen_jobs")
    .get() as { n: number };
  return row.n;
}
