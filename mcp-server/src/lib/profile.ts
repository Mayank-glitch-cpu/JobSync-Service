// User profile: skills.md, experience.md, projects.md, roles.json stored
// under ~/.jobsync/profile/ and editable by hand. The agent reads these at
// the start of every scrape run so role targeting reflects the real user.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.js";

export type ProfileFile = "skills" | "experience" | "projects";

export interface Roles {
  detected: string[];
  custom: string[];
  excluded: string[];
}

const EMPTY_ROLES: Roles = { detected: [], custom: [], excluded: [] };

function profileDir(): string {
  return loadConfig().profileDir;
}

export function ensureProfileDir(): string {
  const dir = profileDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function mdPath(name: ProfileFile): string {
  return join(profileDir(), `${name}.md`);
}

function rolesPath(): string {
  return join(profileDir(), "roles.json");
}

export function readProfileFile(name: ProfileFile): string {
  const p = mdPath(name);
  return existsSync(p) ? readFileSync(p, "utf-8") : "";
}

export function writeProfileFile(name: ProfileFile, content: string): void {
  ensureProfileDir();
  writeFileSync(mdPath(name), content);
}

export function readRoles(): Roles {
  const p = rolesPath();
  if (!existsSync(p)) return { ...EMPTY_ROLES };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as Partial<Roles>;
    return {
      detected: parsed.detected ?? [],
      custom: parsed.custom ?? [],
      excluded: parsed.excluded ?? [],
    };
  } catch {
    return { ...EMPTY_ROLES };
  }
}

export function writeRoles(roles: Roles): void {
  ensureProfileDir();
  writeFileSync(rolesPath(), JSON.stringify(roles, null, 2));
}

export function activeRoles(roles: Roles): string[] {
  const excluded = new Set(roles.excluded.map((r) => r.toLowerCase()));
  const union = new Map<string, string>();
  for (const r of [...roles.detected, ...roles.custom]) {
    if (!excluded.has(r.toLowerCase())) union.set(r.toLowerCase(), r);
  }
  return Array.from(union.values());
}

export function rawResumePath(): string {
  return join(profileDir(), "raw-resume.txt");
}

export function writeRawResume(text: string): void {
  ensureProfileDir();
  writeFileSync(rawResumePath(), text);
}

export function readRawResume(): string {
  return existsSync(rawResumePath()) ? readFileSync(rawResumePath(), "utf-8") : "";
}
