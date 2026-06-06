import { getStore } from "./store/index.js";
import { currentScope } from "./run-context.js";

const NS = "profile";
const FILE = "personal.json";

function scopeDefault(): string {
  return currentScope() ?? "default";
}

/** Per-user doc id; "default" keeps the historical bare name. */
function docId(scope: string): string {
  return scope === "default" ? FILE : `${scope}__${FILE}`;
}

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

export async function readPersonalProfile(
  scope: string = scopeDefault(),
): Promise<Partial<PersonalProfile>> {
  const raw = await (await getStore()).docs.readDoc(NS, docId(scope));
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Partial<PersonalProfile>;
  } catch {
    return {};
  }
}

export async function writePersonalProfile(
  patch: Partial<PersonalProfile>,
  scope: string = scopeDefault(),
): Promise<PersonalProfile> {
  const existing = await readPersonalProfile(scope);
  const merged = { ...existing, ...patch } as PersonalProfile;
  await (await getStore()).docs.writeDoc(NS, docId(scope), JSON.stringify(merged, null, 2));
  return merged;
}
