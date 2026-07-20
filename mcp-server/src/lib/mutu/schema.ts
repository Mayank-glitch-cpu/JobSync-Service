// The 23-field resume record produced by sukhrobnurali/qwen3vl-resume-parser.
// The model bakes this schema into its weights; we validate/normalize its output
// here so a slightly-malformed generation never corrupts the relational store.

import { z } from "zod";

const nullableString = z.string().nullable().catch(null);
const nullableNumber = z.number().nullable().catch(null);

export const AddressSchema = z
  .object({
    country_name: nullableString,
    region_name: nullableString,
  })
  .partial()
  .nullable()
  .catch(null);

export const SkillSchema = z.object({
  skill_name: z.string(),
  level: nullableNumber.or(nullableString),
});

export const ExperienceSchema = z.object({
  company_name: nullableString,
  job: nullableString,
  date_from: nullableString,
  date_to: nullableString,
  description: nullableString,
  country_name: nullableString,
});

export const LanguageSchema = z.object({
  language_name: z.string(),
  level: nullableNumber,
});

export const EducationSchema = z.object({
  name: nullableString,
  degree: nullableString,
  location: nullableString,
  programme: nullableString,
  date_from: nullableString,
  date_to: nullableString,
  country_name: nullableString,
});

export const CertificateSchema = z.object({
  certificate_name: nullableString,
  certificate_programme: nullableString,
  issuing_date: nullableString,
  expiring_date: nullableString,
});

export const ProjectSchema = z.object({
  title: nullableString,
  summary: nullableString,
  used_technologies: z.array(z.string()).catch([]),
  role: nullableString,
  industries: z.array(z.string()).catch([]),
});

export const ParsedResumeSchema = z.object({
  first_name: nullableString,
  last_name: nullableString,
  date_of_birth: nullableString,
  email: nullableString,
  phone: nullableString,
  desired_position: nullableString,
  about: nullableString,
  job_experience: nullableNumber.or(nullableString),
  job_expectations: nullableString,
  min_salary: nullableNumber,
  max_salary: nullableNumber,
  ready_to_relocation: z.boolean().catch(false),
  work_modes: z.array(z.string()).catch([]),
  employment_types: z.array(z.string()).catch([]),
  employment_durations: z.array(z.string()).catch([]),
  hobbies: nullableString,
  address: AddressSchema,
  skills: z.array(SkillSchema).catch([]),
  experiences: z.array(ExperienceSchema).catch([]),
  languages: z.array(LanguageSchema).catch([]),
  educations: z.array(EducationSchema).catch([]),
  certificates: z.array(CertificateSchema).catch([]),
  projects: z.array(ProjectSchema).catch([]),
});

export type ParsedResume = z.infer<typeof ParsedResumeSchema>;

/**
 * Validate a raw parser response into the canonical 23-field record. Individual
 * malformed fields fall back to null/[] (zod .catch) rather than failing the
 * whole parse; only a non-object payload throws.
 */
export function normalizeParsedResume(raw: unknown): ParsedResume {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Resume parser returned a non-object payload.");
  }
  return ParsedResumeSchema.parse(raw);
}

/**
 * True when every identity field and every content array normalized to
 * null/empty. Because the schema is null-tolerant (.catch), a payload in a
 * different shape entirely — e.g. a caller's native parser response instead of
 * the 23-field record — normalizes "successfully" into an all-null record.
 * Callers should treat that as a contract violation, not a stored resume.
 */
export function isEffectivelyEmpty(parsed: ParsedResume): boolean {
  return (
    parsed.first_name === null &&
    parsed.last_name === null &&
    parsed.email === null &&
    parsed.phone === null &&
    parsed.desired_position === null &&
    parsed.skills.length === 0 &&
    parsed.experiences.length === 0 &&
    parsed.educations.length === 0
  );
}
