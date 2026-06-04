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

export interface UnansweredField {
  selector: string;
  label: string;
  type: string;
  required: boolean;
  options: string[];
  frameUrl?: string;
}

export interface FillResult {
  instructions: FillInstruction[];
  essayFields: Array<{ selector: string; label: string; frameUrl?: string; type: string }>;
  unansweredFields: UnansweredField[];
  unfilledRequired: string[];
}

export interface EssayContext {
  company: string;
  jobTitle: string;
  experience: string;
  skills: string;
  projects: string;
}

const US_ALIASES = ["usa", "us", "u.s.", "u.s.a.", "united states", "united states of america", "america"];

/** A field's options are effectively a Yes/No toggle (so a "Yes"/"No" value is valid). */
function isYesNoOptions(options: string[]): boolean {
  if (options.length === 0) return true; // radio/text with no captured options — assume yes/no
  return options.every((o) => /^(yes|no)$/i.test(o.trim()));
}

/**
 * When a standard field is a dropdown/select, the raw profile value may not match
 * an option verbatim (e.g. country "USA" vs option "United States +1"). Pick the
 * best matching option so the value can actually be selected; fall back to raw.
 */
function bestOptionMatch(value: string, options: string[]): string {
  if (!options.length) return value;
  const v = value.toLowerCase().trim();
  const exact = options.find((o) => o.toLowerCase().trim() === v);
  if (exact) return exact;
  if (US_ALIASES.includes(v)) {
    const us = options.find((o) => /united states/i.test(o));
    if (us) return us;
  }
  const sub = options.find((o) => {
    const ol = o.toLowerCase();
    return ol.includes(v) || v.includes(ol);
  });
  return sub ?? value;
}

export function mapStandardFields(
  fields: DetectedField[],
  profile: Partial<PersonalProfile>,
): FillInstruction[] {
  const instructions: FillInstruction[] = [];
  const pushInstr = (field: DetectedField, value: string, type?: string) =>
    instructions.push({
      selector: field.selector,
      label: field.label,
      // For dropdowns, resolve the value to a real option so it can be selected.
      value: field.options && field.options.length ? bestOptionMatch(value, field.options) : value,
      type: (type ?? field.type) as FillInstruction["type"],
      ...(field.frameUrl ? { frameUrl: field.frameUrl } : {}),
    });

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
      // Only auto-map the simple Yes/No form. When the dropdown offers richer
      // choices (e.g. "authorized based on a valid work permit…"), leave it for
      // the agent to pick the correct option from the harvested list.
      if (profile.workAuthorization && isYesNoOptions(field.options ?? [])) {
        const isAuthorized =
          /citizen|green\s*card|permanent\s*resident|ead|authorized/i.test(
            profile.workAuthorization,
          );
        pushInstr(field, isAuthorized ? "Yes" : "No");
      }
      continue;
    }
    if (SPONSORSHIP_PATTERNS.some((p) => p.test(labelLower))) {
      if (profile.requiresSponsorship !== undefined && isYesNoOptions(field.options ?? [])) {
        pushInstr(field, profile.requiresSponsorship ? "Yes" : "No");
      }
      continue;
    }
    // Single full-name field (common on Ashby): combine first + last.
    if (/^(full |legal |your )?name$/.test(labelLower)) {
      const full = [profile.firstName, profile.lastName].filter(Boolean).join(" ").trim();
      if (full) pushInstr(field, full);
      continue;
    }

    // Single "Location" field: combine city/state/country.
    if (/^(current )?location$/.test(labelLower)) {
      const loc = [profile.city, profile.state, profile.country].filter(Boolean).join(", ").trim();
      if (loc) pushInstr(field, loc);
      continue;
    }

    const profileKey = STANDARD_MAP[labelLower];
    if (profileKey) {
      const value = profile[profileKey];
      if (value !== undefined && value !== null && String(value).trim() !== "") {
        pushInstr(field, String(value));
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

/**
 * Every asked field that standard profile mapping did NOT fill and that is not a
 * file upload. This is the full set the agent must compose answers for before we
 * reopen the browser — the hard rule is that EVERY asked field gets an answer.
 * It spans open-text essays AND structured questions (selects, radios, custom
 * text like "Graduation date", "Years of experience", "How did you hear about us").
 */
export function identifyUnansweredFields(
  fields: DetectedField[],
  mappedSelectors: Set<string>,
): UnansweredField[] {
  return fields
    .filter((f) => !mappedSelectors.has(f.selector) && f.type !== "file")
    .map((f) => ({
      selector: f.selector,
      label: f.label,
      type: f.type,
      required: f.required,
      options: f.options ?? [],
      ...(f.frameUrl ? { frameUrl: f.frameUrl } : {}),
    }));
}

/**
 * Build the instruction block that asks the agent to compose an answer for EVERY
 * unanswered field, grounded in the user's profile. For selects/radios/checkboxes
 * the agent must pick the best option from the provided list; for open text it
 * composes a genuine answer. Nothing is left blank — that is the hard rule.
 */
export function buildAnswerPromptBlock(
  unanswered: UnansweredField[],
  ctx: EssayContext,
): string {
  if (unanswered.length === 0) return "";
  const fieldList = unanswered
    .map((f, i) => {
      const req = f.required ? " **(required)**" : "";
      const opts = f.options.length ? ` — choose one of: [${f.options.join(" | ")}]` : "";
      const frame = f.frameUrl ? `, frameUrl: \`${f.frameUrl}\`` : "";
      return `${i + 1}. **${f.label}**${req} [type: ${f.type}]${opts} (selector: \`${f.selector}\`${frame})`;
    })
    .join("\n");

  return `## Fields needing composed answers — HARD RULE: answer EVERY field below

You must produce a value for every field listed. Do not leave any field blank and do not defer to the user. Ground every answer in the applicant profile context below.

- **Open text / textarea** (cover letters, "why this company?", "tell us about yourself"): compose a genuine, first-person answer. 150–300 words for full essays, 1–3 sentences for short prompts. Reference concrete projects, skills, and experience. Tailor to **${ctx.company}** and the role **${ctx.jobTitle}**. Avoid filler like "I am passionate about" or "I would love the opportunity."
- **Select / radio / checkbox**: pick the single best option from the field's option list using the profile. Never invent an option that is not offered.
- **Short factual text** (graduation date, years of experience, salary expectation, "how did you hear about us", notice period): answer from the profile. If a fact is genuinely absent from the profile, choose the most reasonable, non-fabricated value (e.g. a neutral "Referral"/"Company website" for source questions) rather than leaving it empty.

### Fields to answer:
${fieldList}

### Applicant profile context:

**Experience:**
${ctx.experience || "(not provided)"}

**Skills:**
${ctx.skills || "(not provided)"}

**Projects:**
${ctx.projects || "(not provided)"}

After composing every answer, add a FillInstruction for each (selector, label, value, type, and frameUrl when listed). Then call apply_save_draft with the COMPLETE fields array (standard mappings + every answer above).`.trim();
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
  const unansweredFields = identifyUnansweredFields(fields, mappedSelectors);
  const answerableSelectors = new Set(unansweredFields.map((f) => f.selector));

  // Genuinely unfillable required fields: required, not mapped, and not even
  // answerable by the agent (e.g. an unmapped required file upload with no resume).
  const unfilledRequired = fields
    .filter(
      (f) =>
        f.required &&
        !mappedSelectors.has(f.selector) &&
        !answerableSelectors.has(f.selector),
    )
    .map((f) => {
      console.warn(`[apply] UNFILLED_REQUIRED: ${f.label} (${f.selector})`);
      return f.label;
    });

  // The prompt block now covers ALL unanswered fields, not just essay-pattern ones,
  // so the agent answers every asked question before fill + submit.
  const essayPromptBlock = buildAnswerPromptBlock(unansweredFields, {
    company,
    jobTitle,
    experience,
    skills,
    projects,
  });
  return { instructions, essayFields, unansweredFields, unfilledRequired, essayPromptBlock };
}
