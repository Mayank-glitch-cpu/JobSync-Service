// Relational store for the Mutu integration: users (demographics from Mutu),
// resumes (23-field parsed records, 1:1 latest-wins per user), resume_skills
// (queryable skills index), jobs (the retrieval corpus), role_synth_runs
// (LLM role-synthesis outputs). Proper foreign keys, ON DELETE CASCADE.
//
// Uses node:sqlite (Node 22.5+) with the same esbuild-safe dynamic import as
// lib/store/local.ts. Separate DB file (~/.jobsync/mutu.db) so it can't
// interfere with the seen-jobs/response caches. Override with JOBSYNC_MUTU_DB
// (tests point it at a temp dir).

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ParsedResume } from "./schema.js";

type DatabaseSyncCtor = new (path: string) => {
  exec(sql: string): void;
  close(): void;
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number | bigint };
    all(...params: unknown[]): unknown[];
  };
};

let DatabaseSyncPromise: Promise<DatabaseSyncCtor> | null = null;
function loadDatabaseSync(): Promise<DatabaseSyncCtor> {
  if (!DatabaseSyncPromise) {
    // Built the name at runtime so esbuild can't strip the node: prefix.
    const moduleName = ["node", "sqlite"].join(":");
    // process.getBuiltinModule (Node 22.3+) bypasses every bundler/test loader
    // (vite-node rewrites even @vite-ignore dynamic imports); fall back to a
    // dynamic import for completeness.
    const viaBuiltin = (
      process as unknown as { getBuiltinModule?: (id: string) => unknown }
    ).getBuiltinModule?.(moduleName);
    DatabaseSyncPromise = viaBuiltin
      ? Promise.resolve((viaBuiltin as { DatabaseSync: DatabaseSyncCtor }).DatabaseSync)
      : import(/* @vite-ignore */ moduleName).then(
          (m) => (m as { DatabaseSync: DatabaseSyncCtor }).DatabaseSync,
        );
  }
  return DatabaseSyncPromise;
}

type Db = InstanceType<DatabaseSyncCtor>;
let db: Db | null = null;

function dbPath(): string {
  return process.env.JOBSYNC_MUTU_DB ?? join(homedir(), ".jobsync", "mutu.db");
}

async function getDb(): Promise<Db> {
  if (db) return db;
  const path = dbPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const DatabaseSync = await loadDatabaseSync();
  db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      user_id            TEXT PRIMARY KEY,
      email              TEXT NOT NULL UNIQUE,
      first_name         TEXT,
      last_name          TEXT,
      country            TEXT,
      work_authorization TEXT,
      linkedin           TEXT,
      github             TEXT,
      google_scholar     TEXT,
      extra_links        TEXT NOT NULL DEFAULT '{}',
      created_at         TEXT NOT NULL,
      updated_at         TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS resumes (
      resume_id        TEXT PRIMARY KEY,
      user_id          TEXT NOT NULL UNIQUE REFERENCES users(user_id) ON DELETE CASCADE,
      parsed           TEXT NOT NULL,
      desired_position TEXT,
      min_salary       REAL,
      max_salary       REAL,
      ready_to_relocate INTEGER NOT NULL DEFAULT 0,
      parser_model     TEXT NOT NULL,
      parsed_at        TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS resume_skills (
      resume_id  TEXT NOT NULL REFERENCES resumes(resume_id) ON DELETE CASCADE,
      skill_name TEXT NOT NULL,
      level      TEXT,
      PRIMARY KEY (resume_id, skill_name)
    );
    CREATE INDEX IF NOT EXISTS idx_resume_skills_name
      ON resume_skills(skill_name COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS jobs (
      job_id         TEXT PRIMARY KEY,
      url_hash       TEXT NOT NULL UNIQUE,
      company        TEXT NOT NULL,
      position_title TEXT NOT NULL,
      apply_link     TEXT,
      location       TEXT,
      source         TEXT,
      tags           TEXT NOT NULL DEFAULT '[]',
      posted_at      TEXT,
      created_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_title ON jobs(position_title COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_jobs_location ON jobs(location COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS role_synth_runs (
      run_id       TEXT PRIMARY KEY,
      created_at   TEXT NOT NULL,
      user_count   INTEGER NOT NULL,
      resume_count INTEGER NOT NULL,
      roles        TEXT NOT NULL,
      model        TEXT NOT NULL
    );
  `);
  return db;
}

/** Reset the memoized connection (tests swap JOBSYNC_MUTU_DB between cases). */
export function resetMutuDbForTests(): void {
  // Close so Windows releases the file handle before the temp dir is removed.
  try {
    db?.close();
  } catch {
    // already closed
  }
  db = null;
}

const now = () => new Date().toISOString();

// ── Users ────────────────────────────────────────────────────────────────────

export interface MutuUserInput {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  country?: string | null;
  workAuthorization?: string | null;
  linkedin?: string | null;
  github?: string | null;
  googleScholar?: string | null;
  extraLinks?: Record<string, string>;
}

export interface MutuUser extends Required<Omit<MutuUserInput, "extraLinks">> {
  userId: string;
  extraLinks: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToUser(r: any): MutuUser {
  return {
    userId: r.user_id,
    email: r.email,
    firstName: r.first_name ?? null,
    lastName: r.last_name ?? null,
    country: r.country ?? null,
    workAuthorization: r.work_authorization ?? null,
    linkedin: r.linkedin ?? null,
    github: r.github ?? null,
    googleScholar: r.google_scholar ?? null,
    extraLinks: JSON.parse(r.extra_links ?? "{}"),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Insert or update a user keyed by email (Mutu retries safely). */
export async function upsertUser(input: MutuUserInput): Promise<MutuUser> {
  const d = await getDb();
  const email = input.email.trim().toLowerCase();
  if (!email) throw new Error("email is required");
  const existing = d.prepare("SELECT * FROM users WHERE email = ?").get(email) as
    | Record<string, unknown>
    | undefined;
  const ts = now();
  if (existing) {
    d.prepare(
      `UPDATE users SET
         first_name = COALESCE(?, first_name),
         last_name = COALESCE(?, last_name),
         country = COALESCE(?, country),
         work_authorization = COALESCE(?, work_authorization),
         linkedin = COALESCE(?, linkedin),
         github = COALESCE(?, github),
         google_scholar = COALESCE(?, google_scholar),
         extra_links = COALESCE(?, extra_links),
         updated_at = ?
       WHERE email = ?`,
    ).run(
      input.firstName ?? null,
      input.lastName ?? null,
      input.country ?? null,
      input.workAuthorization ?? null,
      input.linkedin ?? null,
      input.github ?? null,
      input.googleScholar ?? null,
      input.extraLinks ? JSON.stringify(input.extraLinks) : null,
      ts,
      email,
    );
    return rowToUser(d.prepare("SELECT * FROM users WHERE email = ?").get(email));
  }
  const userId = randomUUID();
  d.prepare(
    `INSERT INTO users (user_id, email, first_name, last_name, country, work_authorization,
       linkedin, github, google_scholar, extra_links, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    userId,
    email,
    input.firstName ?? null,
    input.lastName ?? null,
    input.country ?? null,
    input.workAuthorization ?? null,
    input.linkedin ?? null,
    input.github ?? null,
    input.googleScholar ?? null,
    JSON.stringify(input.extraLinks ?? {}),
    ts,
    ts,
  );
  return rowToUser(d.prepare("SELECT * FROM users WHERE user_id = ?").get(userId));
}

export async function getUser(userId: string): Promise<MutuUser | null> {
  const d = await getDb();
  const row = d.prepare("SELECT * FROM users WHERE user_id = ?").get(userId);
  return row ? rowToUser(row) : null;
}

export async function listUsers(limit = 500): Promise<MutuUser[]> {
  const d = await getDb();
  return d
    .prepare("SELECT * FROM users ORDER BY created_at DESC LIMIT ?")
    .all(limit)
    .map(rowToUser);
}

// ── Resumes ──────────────────────────────────────────────────────────────────

export interface StoredResume {
  resumeId: string;
  userId: string;
  parsed: ParsedResume;
  parserModel: string;
  parsedAt: string;
}

/** Store (latest-wins) the parsed 23-field record for a user + reindex skills. */
export async function saveResume(
  userId: string,
  parsed: ParsedResume,
  parserModel: string,
): Promise<StoredResume> {
  const d = await getDb();
  if (!(await getUser(userId))) throw new Error(`unknown user: ${userId}`);
  d.prepare("DELETE FROM resumes WHERE user_id = ?").run(userId); // cascades to skills
  const resumeId = randomUUID();
  const ts = now();
  d.prepare(
    `INSERT INTO resumes (resume_id, user_id, parsed, desired_position, min_salary,
       max_salary, ready_to_relocate, parser_model, parsed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    resumeId,
    userId,
    JSON.stringify(parsed),
    parsed.desired_position,
    parsed.min_salary,
    parsed.max_salary,
    parsed.ready_to_relocation ? 1 : 0,
    parserModel,
    ts,
  );
  const insertSkill = d.prepare(
    "INSERT OR IGNORE INTO resume_skills (resume_id, skill_name, level) VALUES (?, ?, ?)",
  );
  for (const s of parsed.skills) {
    if (s.skill_name?.trim()) {
      insertSkill.run(resumeId, s.skill_name.trim(), s.level === null ? null : String(s.level));
    }
  }
  return { resumeId, userId, parsed, parserModel, parsedAt: ts };
}

export async function getResume(userId: string): Promise<StoredResume | null> {
  const d = await getDb();
  const r = d.prepare("SELECT * FROM resumes WHERE user_id = ?").get(userId) as
    | Record<string, unknown>
    | undefined;
  if (!r) return null;
  return {
    resumeId: r.resume_id as string,
    userId: r.user_id as string,
    parsed: JSON.parse(r.parsed as string) as ParsedResume,
    parserModel: r.parser_model as string,
    parsedAt: r.parsed_at as string,
  };
}

export async function listResumes(limit = 500): Promise<StoredResume[]> {
  const d = await getDb();
  return (d.prepare("SELECT * FROM resumes ORDER BY parsed_at DESC LIMIT ?").all(limit) as Array<
    Record<string, unknown>
  >).map((r) => ({
    resumeId: r.resume_id as string,
    userId: r.user_id as string,
    parsed: JSON.parse(r.parsed as string) as ParsedResume,
    parserModel: r.parser_model as string,
    parsedAt: r.parsed_at as string,
  }));
}

// ── Jobs ─────────────────────────────────────────────────────────────────────

export interface MutuJobInput {
  company: string;
  positionTitle: string;
  applyLink?: string | null;
  location?: string | null;
  source?: string | null;
  tags?: string[];
  postedAt?: string | null;
}

export interface MutuJob extends MutuJobInput {
  jobId: string;
  tags: string[];
  createdAt: string;
}

const hashLink = (job: MutuJobInput): string =>
  createHash("sha256")
    .update((job.applyLink ?? `${job.company}::${job.positionTitle}`).toLowerCase())
    .digest("hex");

/** Bulk upsert (dedup on apply-link hash). Returns inserted count. */
export async function ingestJobs(jobs: MutuJobInput[]): Promise<number> {
  const d = await getDb();
  const stmt = d.prepare(
    `INSERT OR IGNORE INTO jobs (job_id, url_hash, company, position_title, apply_link,
       location, source, tags, posted_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const ts = now();
  let inserted = 0;
  for (const j of jobs) {
    if (!j.company?.trim() || !j.positionTitle?.trim()) continue;
    const res = stmt.run(
      randomUUID(),
      hashLink(j),
      j.company.trim(),
      j.positionTitle.trim(),
      j.applyLink ?? null,
      j.location ?? null,
      j.source ?? null,
      JSON.stringify(j.tags ?? []),
      j.postedAt ?? null,
      ts,
    );
    inserted += Number(res.changes);
  }
  return inserted;
}

export interface JobQuery {
  role?: string;
  skills?: string[];
  country?: string;
  limit?: number;
}

/** Retrieval endpoint for Mutu's recsys: title/tag keyword + location filter. */
export async function queryJobs(q: JobQuery): Promise<MutuJob[]> {
  const d = await getDb();
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (q.role?.trim()) {
    clauses.push("position_title LIKE ? COLLATE NOCASE");
    params.push(`%${q.role.trim()}%`);
  }
  if (q.country?.trim()) {
    clauses.push("(location LIKE ? COLLATE NOCASE OR location IS NULL)");
    params.push(`%${q.country.trim()}%`);
  }
  if (q.skills?.length) {
    // Any-skill match against title or tags.
    const skillClause = q.skills
      .map(() => "(position_title LIKE ? COLLATE NOCASE OR tags LIKE ? COLLATE NOCASE)")
      .join(" OR ");
    clauses.push(`(${skillClause})`);
    for (const s of q.skills) {
      params.push(`%${s}%`, `%${s}%`);
    }
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(500, q.limit ?? 100));
  const rows = d
    .prepare(`SELECT * FROM jobs ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params, limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    jobId: r.job_id as string,
    company: r.company as string,
    positionTitle: r.position_title as string,
    applyLink: (r.apply_link as string) ?? null,
    location: (r.location as string) ?? null,
    source: (r.source as string) ?? null,
    tags: JSON.parse((r.tags as string) ?? "[]"),
    postedAt: (r.posted_at as string) ?? null,
    createdAt: r.created_at as string,
  }));
}

// ── Role synthesis runs ──────────────────────────────────────────────────────

export interface SynthesizedRole {
  role: string;
  rationale: string;
  demand_signals: string[];
}

export interface RoleSynthRun {
  runId: string;
  createdAt: string;
  userCount: number;
  resumeCount: number;
  roles: SynthesizedRole[];
  model: string;
}

export async function saveRoleSynthRun(
  run: Omit<RoleSynthRun, "runId" | "createdAt">,
): Promise<RoleSynthRun> {
  const d = await getDb();
  const runId = randomUUID();
  const createdAt = now();
  d.prepare(
    `INSERT INTO role_synth_runs (run_id, created_at, user_count, resume_count, roles, model)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(runId, createdAt, run.userCount, run.resumeCount, JSON.stringify(run.roles), run.model);
  return { runId, createdAt, ...run };
}

export async function latestRoleSynthRun(): Promise<RoleSynthRun | null> {
  const d = await getDb();
  const r = d
    .prepare("SELECT * FROM role_synth_runs ORDER BY created_at DESC LIMIT 1")
    .get() as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    runId: r.run_id as string,
    createdAt: r.created_at as string,
    userCount: r.user_count as number,
    resumeCount: r.resume_count as number,
    roles: JSON.parse(r.roles as string),
    model: r.model as string,
  };
}
