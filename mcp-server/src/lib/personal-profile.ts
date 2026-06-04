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
  // Voluntary EEO / self-identification answers used to fill demographic questions
  // on application forms. All optional — the user may decline any of them.
  // e.g. "Asian" | "White" | "Black or African American" | "Hispanic or Latino" |
  //      "Native American" | "Two or More Races" | "Decline to self-identify"
  ethnicity: string;
  // "Yes" | "No" | "Decline to self-identify" (protected-veteran status)
  veteranStatus: string;
  // "Yes" | "No" | "Decline to self-identify"
  disabilityStatus: string;
  // If disabilityStatus is "Yes", an optional description of the disability.
  disabilityDetails: string;
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
