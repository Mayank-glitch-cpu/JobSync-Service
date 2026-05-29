import type { DetectedField, FillInstruction } from "./browser-apply.js";
import type { PersonalProfile } from "./personal-profile.js";

const STANDARD_MAP: Record<string, keyof PersonalProfile> = {
  "first name": "firstName",
  "given name": "firstName",
  "last name": "lastName",
  "surname": "lastName",
  "family name": "lastName",
  "email": "email",
  "email address": "email",
  "phone": "phone",
  "mobile": "phone",
  "telephone": "phone",
  "phone number": "phone",
  "linkedin": "linkedinUrl",
  "linkedin url": "linkedinUrl",
  "linkedin profile": "linkedinUrl",
  "github": "githubUrl",
  "github url": "githubUrl",
  "github profile": "githubUrl",
  "portfolio": "portfolioUrl",
  "website": "portfolioUrl",
  "personal website": "portfolioUrl",
  "portfolio url": "portfolioUrl",
  "city": "city",
  "state": "state",
  "province": "state",
  "country": "country",
};

const WORK_AUTH_PATTERNS = [
  /authorized to work/i,
  /legally authorized/i,
  /work authorization/i,
  /eligible to work/i,
  /right to work/i,
];

const SPONSORSHIP_PATTERNS = [
  /require.*sponsor/i,
  /sponsorship/i,
  /visa.*sponsor/i,
  /sponsor.*visa/i,
  /need.*sponsor/i,
];

export const ESSAY_PATTERNS = [
  /cover letter/i,
  /why.*(?:company|us|this|role|position)/i,
  /tell us about/i,
  /about yourself/i,
  /motivat/i,        // matches "motivation", "motivates", "motivated"
  /\bfit\b/i,
  /background/i,
  /why do you/i,
  /why are you/i,
  /what excites/i,
  /what interests/i,
  /describe.*(?:yourself|experience|background)/i,
];

export interface FillResult {
  instructions: FillInstruction[];
  essayFields: Array<{ selector: string; label: string; frameUrl?: string; type: string }>;
  unfilledRequired: string[];
}

export interface EssayContext {
  company: string;
  jobTitle: string;
  experience: string;
  skills: string;
  projects: string;
}

export function mapStandardFields(
  fields: DetectedField[],
  profile: Partial<PersonalProfile>,
): FillInstruction[] {
  const instructions: FillInstruction[] = [];
  for (const field of fields) {
    const labelLower = field.label.toLowerCase().replace(/[*:]/g, "").trim();
    if (/resume|cv|curriculum vitae/.test(labelLower) && field.type === "file") {
      if (profile.resumePath) {
        instructions.push({
          selector: field.selector,
          label: field.label,
          value: profile.resumePath,
          type: "file",
          ...(field.frameUrl ? { frameUrl: field.frameUrl } : {}),
        });
      }
      continue;
    }
    if (WORK_AUTH_PATTERNS.some((p) => p.test(labelLower))) {
      if (profile.workAuthorization) {
        const isAuthorized =
          /citizen|green\s*card|permanent\s*resident|ead|authorized/i.test(
            profile.workAuthorization,
          );
        instructions.push({
          selector: field.selector,
          label: field.label,
          value: isAuthorized ? "Yes" : "No",
          type: field.type as FillInstruction["type"],
          ...(field.frameUrl ? { frameUrl: field.frameUrl } : {}),
        });
      }
      continue;
    }
    if (SPONSORSHIP_PATTERNS.some((p) => p.test(labelLower))) {
      if (profile.requiresSponsorship !== undefined) {
        instructions.push({
          selector: field.selector,
          label: field.label,
          value: profile.requiresSponsorship ? "Yes" : "No",
          type: field.type as FillInstruction["type"],
          ...(field.frameUrl ? { frameUrl: field.frameUrl } : {}),
        });
      }
      continue;
    }
    const profileKey = STANDARD_MAP[labelLower];
    if (profileKey) {
      const value = profile[profileKey];
      if (value !== undefined && value !== null && String(value).trim() !== "") {
        instructions.push({
          selector: field.selector,
          label: field.label,
          value: String(value),
          type: field.type as FillInstruction["type"],
          ...(field.frameUrl ? { frameUrl: field.frameUrl } : {}),
        });
      }
    }
  }
  return instructions;
}

export function identifyEssayFields(
  fields: DetectedField[],
  mappedSelectors: Set<string>,
): Array<{ selector: string; label: string; frameUrl?: string; type: string }> {
  return fields.filter(
    (f) =>
      !mappedSelectors.has(f.selector) &&
      (f.type === "textarea" || f.type === "text") &&
      ESSAY_PATTERNS.some((p) => p.test(f.label)),
  );
}

export function buildEssayPromptBlock(
  essayFields: Array<{ selector: string; label: string; frameUrl?: string; type: string }>,
  ctx: EssayContext,
): string {
  if (essayFields.length === 0) return "";
  const fieldList = essayFields
    .map(
      (f, i) =>
        `${i + 1}. **${f.label}** (selector: \`${f.selector}\`${f.frameUrl ? `, frameUrl: \`${f.frameUrl}\`` : ""})`,
    )
    .join("\n");
  return `## Essay fields requiring AI generation

For each field below, compose a genuine, personalized answer (150-300 words for cover letters/full essays; 1-3 sentences for short prompts). Use first person. Reference concrete projects, skills, and experience. Tailor to **${ctx.company}** and the role **${ctx.jobTitle}**. Avoid filler phrases like "I am passionate about" or "I would love the opportunity."

### Fields to fill:
${fieldList}

### Applicant profile context:

**Experience:**
${ctx.experience || "(not provided)"}

**Skills:**
${ctx.skills || "(not provided)"}

**Projects:**
${ctx.projects || "(not provided)"}

After generating each answer, add a FillInstruction with selector, label, value, type, and frameUrl if listed. Then call apply_save_draft with the complete fields array.`.trim();
}

export function fillFields(
  fields: DetectedField[],
  profile: Partial<PersonalProfile>,
  company: string,
  jobTitle: string,
  experience: string,
  skills: string,
  projects: string,
): FillResult & { essayPromptBlock: string } {
  const instructions = mapStandardFields(fields, profile);
  const mappedSelectors = new Set(instructions.map((i) => i.selector));
  const essayFields = identifyEssayFields(fields, mappedSelectors);
  const unfilledRequired = fields
    .filter(
      (f) =>
        f.required &&
        !mappedSelectors.has(f.selector) &&
        !essayFields.some((e) => e.selector === f.selector),
    )
    .map((f) => {
      console.warn(`[apply] UNFILLED_REQUIRED: ${f.label} (${f.selector})`);
      return f.label;
    });
  const essayPromptBlock = buildEssayPromptBlock(essayFields, {
    company,
    jobTitle,
    experience,
    skills,
    projects,
  });
  return { instructions, essayFields, unfilledRequired, essayPromptBlock };
}
