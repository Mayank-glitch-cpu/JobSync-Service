import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.js";

export interface PersonalProfile {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  linkedinUrl: string;
  githubUrl: string;
  portfolioUrl: string;
  // "US Citizen" | "Green Card" | "H1B Visa" | "OPT" | "CPT" | "TN Visa" | "Other"
  workAuthorization: string;
  requiresSponsorship: boolean;
  // Absolute path to resume PDF or DOCX for file upload
  resumePath: string;
  city: string;
  state: string;
  country: string;
}

function personalPath(): string {
  return join(loadConfig().profileDir, "personal.json");
}

function ensureDir(): void {
  const dir = loadConfig().profileDir;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function readPersonalProfile(): Partial<PersonalProfile> {
  const p = personalPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as Partial<PersonalProfile>;
  } catch {
    return {};
  }
}

export function writePersonalProfile(patch: Partial<PersonalProfile>): PersonalProfile {
  ensureDir();
  const existing = readPersonalProfile();
  const merged = { ...existing, ...patch } as PersonalProfile;
  writeFileSync(personalPath(), JSON.stringify(merged, null, 2), "utf-8");
  return merged;
}
