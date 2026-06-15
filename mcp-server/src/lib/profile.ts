// User profile: skills.md, experience.md, projects.md, roles.json. Stored via
// the StorageAdapter (locally under ~/.jobsync/profile/, in the cloud via
// Firestore). The agent reads these at the start of every scrape run so role
// targeting reflects the real user.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getStorageConfig, loadConfig } from "../config.js";
import { getStore } from "./store/index.js";
import { currentScope } from "./run-context.js";
import { downloadGcsObject, uploadBufferToGcs } from "./gcs.js";

export type ProfileFile = "skills" | "experience" | "projects";

export interface Roles {
  detected: string[];
  custom: string[];
  excluded: string[];
}

const EMPTY_ROLES: Roles = { detected: [], custom: [], excluded: [] };
const NS = "profile";

function scopeDefault(): string {
  return currentScope() ?? "default";
}

/**
 * Per-user doc id. "default" (single-user/stdio) keeps the historical bare file
 * name; multi-user callers get a `<uid>__<name>` id so profiles are isolated.
 */
function docId(scope: string, name: string): string {
  return scope === "default" ? name : `${scope}__${name}`;
}

function profileDir(): string {
  return loadConfig().profileDir;
}

/**
 * Ensure the local profile directory exists. No-op when using a cloud backend
 * (Firestore needs no directory). Returns the logical profile dir path.
 */
export function ensureProfileDir(): string {
  const dir = profileDir();
  if (getStorageConfig().backend === "local" && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export async function readProfileFile(name: ProfileFile, scope: string = scopeDefault()): Promise<string> {
  return (await (await getStore()).docs.readDoc(NS, docId(scope, `${name}.md`))) ?? "";
}

export async function writeProfileFile(
  name: ProfileFile,
  content: string,
  scope: string = scopeDefault(),
): Promise<void> {
  await (await getStore()).docs.writeDoc(NS, docId(scope, `${name}.md`), content);
}

export async function readRoles(scope: string = scopeDefault()): Promise<Roles> {
  const raw = await (await getStore()).docs.readDoc(NS, docId(scope, "roles.json"));
  if (!raw) return { ...EMPTY_ROLES };
  try {
    const parsed = JSON.parse(raw) as Partial<Roles>;
    return {
      detected: parsed.detected ?? [],
      custom: parsed.custom ?? [],
      excluded: parsed.excluded ?? [],
    };
  } catch {
    return { ...EMPTY_ROLES };
  }
}

export async function writeRoles(roles: Roles, scope: string = scopeDefault()): Promise<void> {
  await (await getStore()).docs.writeDoc(NS, docId(scope, "roles.json"), JSON.stringify(roles, null, 2));
}

export function activeRoles(roles: Roles): string[] {
  const excluded = new Set(roles.excluded.map((r) => r.toLowerCase()));
  const union = new Map<string, string>();
  for (const r of [...roles.detected, ...roles.custom]) {
    if (!excluded.has(r.toLowerCase())) union.set(r.toLowerCase(), r);
  }
  return Array.from(union.values());
}

/** Logical location label (the local file path) — for display/diagnostics only. */
export function rawResumePath(): string {
  return join(profileDir(), "raw-resume.txt");
}

export async function writeRawResume(text: string, scope: string = scopeDefault()): Promise<void> {
  await (await getStore()).docs.writeDoc(NS, docId(scope, "raw-resume.txt"), text);
}

export async function readRawResume(scope: string = scopeDefault()): Promise<string> {
  return (await (await getStore()).docs.readDoc(NS, docId(scope, "raw-resume.txt"))) ?? "";
}

// ── Resume binary (for file-upload fields on application forms) ──────────────────
// We keep the ORIGINAL resume bytes (not just the parsed text) so Auto-Apply can
// attach the real file to a "Resume/CV" upload field. Storage strategy:
//   - GCS bucket configured → store the bytes in GCS (object path in the meta doc),
//     avoiding Firestore's ~1MB per-document cap.
//   - otherwise → base64 in the docs store (fine for local SQLite/files).

interface ResumeMeta {
  filename: string;
  /** GCS object path when stored in GCS; absent when bytes live in the docs store. */
  gcsObject?: string;
  updatedAt: string;
}

/** Persist the original resume bytes + filename for later upload. */
export async function writeResumeBlob(
  base64: string,
  filename: string,
  scope: string = scopeDefault(),
): Promise<void> {
  const store = (await getStore()).docs;
  const safeName = filename.replace(/[^\w.\-]/g, "_") || "resume.pdf";
  const gcsObject = await uploadBufferToGcs(
    Buffer.from(base64, "base64"),
    `resumes/${scope}/${safeName}`,
  );
  const meta: ResumeMeta = { filename: safeName, updatedAt: new Date().toISOString() };
  if (gcsObject) {
    meta.gcsObject = gcsObject;
    // Drop any stale inline copy so we don't keep two sources of truth.
    await store.deleteDoc(NS, docId(scope, "resume.b64")).catch(() => {});
  } else {
    await store.writeDoc(NS, docId(scope, "resume.b64"), base64);
  }
  await store.writeDoc(NS, docId(scope, "resume.meta.json"), JSON.stringify(meta));
}

/** Read the stored resume bytes + filename, or null when none uploaded. */
export async function readResumeBlob(
  scope: string = scopeDefault(),
): Promise<{ buffer: Buffer; filename: string } | null> {
  const store = (await getStore()).docs;
  const rawMeta = await store.readDoc(NS, docId(scope, "resume.meta.json"));
  if (!rawMeta) return null;
  let meta: ResumeMeta;
  try {
    meta = JSON.parse(rawMeta) as ResumeMeta;
  } catch {
    return null;
  }
  if (meta.gcsObject) {
    const buf = await downloadGcsObject(meta.gcsObject);
    return buf ? { buffer: buf, filename: meta.filename } : null;
  }
  const b64 = await store.readDoc(NS, docId(scope, "resume.b64"));
  if (!b64) return null;
  return { buffer: Buffer.from(b64, "base64"), filename: meta.filename };
}

/**
 * Write the stored resume to an OS temp file and return its absolute path so a
 * browser file-upload field can attach it. Returns null when no resume is stored.
 * The caller is responsible for cleaning up the returned file when done.
 */
export async function materializeResumeFile(scope: string = scopeDefault()): Promise<string | null> {
  const blob = await readResumeBlob(scope);
  if (!blob) return null;
  const dir = join(tmpdir(), `jobsync-resume-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, blob.filename);
  writeFileSync(path, blob.buffer);
  return path;
}
