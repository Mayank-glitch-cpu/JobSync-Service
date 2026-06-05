import { getStore } from "./store/index.js";

const NS = "profile";
const ID = "personal.json";

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

export async function readPersonalProfile(): Promise<Partial<PersonalProfile>> {
  const raw = await (await getStore()).docs.readDoc(NS, ID);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Partial<PersonalProfile>;
  } catch {
    return {};
  }
}

export async function writePersonalProfile(patch: Partial<PersonalProfile>): Promise<PersonalProfile> {
  const existing = await readPersonalProfile();
  const merged = { ...existing, ...patch } as PersonalProfile;
  await (await getStore()).docs.writeDoc(NS, ID, JSON.stringify(merged, null, 2));
  return merged;
}
