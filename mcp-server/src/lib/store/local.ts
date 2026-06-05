// Local storage backend: SQLite (seen-jobs dedup + response cache) plus plain
// files under ~/.jobsync for app-state docs. This is the original behavior,
// lifted out of cache.ts/pipeline.ts/etc behind the StorageAdapter interface,
// so existing stdio installs are unaffected.
//
// Uses the built-in node:sqlite module (stable in Node 22.5+ / Node 24) to
// avoid a native-compile dependency on the user's machine.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CACHE_DB_PATH, CONFIG_DIR, loadConfig } from "../../config.js";
import type {
  DocStore,
  ResponseCacheStore,
  SeenJob,
  SeenJobsStore,
  StorageAdapter,
} from "./types.js";

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
    // @vite-ignore keeps Vitest/vite-node from trying to pre-resolve the
    // computed specifier (it doesn't recognize the `node:sqlite` builtin and
    // would fail); at runtime Node imports the builtin natively. Harmless to
    // the tsup/esbuild production build.
    DatabaseSyncPromise = import(/* @vite-ignore */ moduleName).then(
      (m) => (m as { DatabaseSync: DatabaseSyncCtor }).DatabaseSync,
    );
  }
  return DatabaseSyncPromise;
}

type Db = InstanceType<DatabaseSyncCtor>;
let db: Db | null = null;

async function getDb(): Promise<Db> {
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
    CREATE TABLE IF NOT EXISTS response_cache (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_expires_at ON response_cache(expires_at);
  `);
  return db;
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

const seenJobs: SeenJobsStore = {
  async isSeen(applyLink) {
    const hash = hashUrl(applyLink);
    const row = (await getDb())
      .prepare(
        "SELECT url_hash AS urlHash, apply_link AS applyLink, company, position_title AS positionTitle, seen_at AS seenAt FROM seen_jobs WHERE url_hash = ?",
      )
      .get(hash) as SeenJob | undefined;
    return row ?? null;
  },

  async markSeen(job) {
    const hash = hashUrl(job.applyLink);
    (await getDb())
      .prepare(
        "INSERT OR REPLACE INTO seen_jobs (url_hash, apply_link, company, position_title, seen_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(hash, job.applyLink, job.company, job.positionTitle, new Date().toISOString());
  },

  async markSeenBatch(jobs) {
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
  },

  async pruneOlderThan(days) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const result = (await getDb())
      .prepare("DELETE FROM seen_jobs WHERE seen_at < ?")
      .run(cutoff);
    return Number(result.changes);
  },

  async size() {
    const row = (await getDb())
      .prepare("SELECT COUNT(*) AS n FROM seen_jobs")
      .get() as { n: number };
    return row.n;
  },
};

const responseCache: ResponseCacheStore = {
  async get(key) {
    const row = (await getDb())
      .prepare("SELECT value, expires_at AS expiresAt FROM response_cache WHERE key = ?")
      .get(key) as { value: string; expiresAt: string } | undefined;
    if (!row) return null;
    if (new Date(row.expiresAt).getTime() <= Date.now()) return null;
    return row.value;
  },

  async set(key, value, ttlSeconds) {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    (await getDb())
      .prepare(
        "INSERT OR REPLACE INTO response_cache (key, value, expires_at) VALUES (?, ?, ?)",
      )
      .run(key, value, expiresAt);
  },

  async prune() {
    const result = (await getDb())
      .prepare("DELETE FROM response_cache WHERE expires_at < ?")
      .run(new Date().toISOString());
    return Number(result.changes);
  },
};

function profileDir(): string {
  try {
    return loadConfig().profileDir;
  } catch {
    return join(homedir(), ".jobsync", "profile");
  }
}

// Map a (namespace, id) pair to a file path, preserving the historical
// ~/.jobsync layout so existing local installs keep their files in place.
function docPath(namespace: string, id: string): string {
  if (namespace === "pipeline") return join(CONFIG_DIR, "pipeline.tsv");
  if (namespace === "portals") return join(CONFIG_DIR, "portals.yml");
  if (namespace === "profile") return join(profileDir(), id);
  return join(CONFIG_DIR, "docs", namespace, id);
}

const docs: DocStore = {
  async readDoc(namespace, id) {
    const p = docPath(namespace, id);
    return existsSync(p) ? readFileSync(p, "utf-8") : null;
  },

  async writeDoc(namespace, id, body) {
    const p = docPath(namespace, id);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body, "utf-8");
  },

  async deleteDoc(namespace, id) {
    const p = docPath(namespace, id);
    if (existsSync(p)) rmSync(p, { force: true });
  },

  async listDocs(namespace) {
    const dir = dirname(docPath(namespace, "_"));
    if (!existsSync(dir)) return [];
    return readdirSync(dir);
  },
};

export const localAdapter: StorageAdapter = {
  backend: "local",
  seenJobs,
  responseCache,
  docs,
};
