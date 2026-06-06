// User profile: skills.md, experience.md, projects.md, roles.json. Stored via
// the StorageAdapter (locally under ~/.jobsync/profile/, in the cloud via
// Firestore). The agent reads these at the start of every scrape run so role
// targeting reflects the real user.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getStorageConfig, loadConfig } from "../config.js";
import { getStore } from "./store/index.js";
import { currentScope } from "./run-context.js";

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
