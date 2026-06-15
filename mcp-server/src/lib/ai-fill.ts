import type { DetectedField, FillInstruction } from "./browser-apply.js";
import type { PersonalProfile } from "./personal-profile.js";
import { normalizeLabel } from "./qa-memory.js";

/** Remembered answers keyed by normalized label (see qa-memory.ts). */
export type QaMemoryMap = Record<string, string>;

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
  "twitter": "twitterUrl",
  "twitter url": "twitterUrl",
  "x url": "twitterUrl",
  "x profile": "twitterUrl",
  "x (twitter)": "twitterUrl",
  "google scholar": "scholarUrl",
  "scholar": "scholarUrl",
  "google scholar url": "scholarUrl",
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

// Voluntary EEO self-identification questions. These show up as selects/radios on
// most US applications; map them from the profile so the agent does not have to
// compose an answer (and never guesses a protected characteristic).
const ETHNICITY_PATTERNS = [/race/i, /ethnicity/i, /ethnic\s+group/i, /hispanic\s+or\s+latino/i];
const VETERAN_PATTERNS = [/veteran/i, /protected\s+veteran/i, /military\s+service/i];
const DISABILITY_PATTERNS = [/disabilit/i, /disabled/i];
// Gender / sex. Kept narrow so it can't hijack unrelated questions ("gender of the
// team", etc. are vanishingly rare on application forms).
const GENDER_PATTERNS = [/\bgender\b/i, /\bsex\b/i, /gender\s+identity/i];

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

/** Split a string into lowercase alphanumeric tokens for fuzzy comparison. */
function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * When a standard field is a dropdown/select, the raw profile value rarely matches
 * an option verbatim. The dropdown may abbreviate ("California" → "CA"), append a
 * dial code ("United States +1"), reorder parts, or list only the city ("San
 * Francisco" when the profile says "San Francisco, California, United States").
 *
 * Resolve the value to the best offered option by reasoning over the choices in
 * stages rather than insisting on a full-string match:
 *   1. exact match
 *   2. US aliases → "United States" option
 *   3. substring either direction (whole value inside an option, or vice-versa)
 *   4. token overlap — pick the option that shares the most words with the value
 *      (handles "San Francisco, California, US" ↔ option "San Francisco, CA")
 * Falls back to the raw value (typed as free text) only when nothing overlaps.
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
    const ol = o.toLowerCase().trim();
    return ol.includes(v) || v.includes(ol);
  });
  if (sub) return sub;

  // Token-overlap scoring: the option that shares the most words with the value
  // wins (e.g. profile "San Francisco, California, United States" → option "San
  // Francisco, CA, USA" share "san"+"francisco"). Tie-break toward the option
  // whose words are most fully covered by the value, so a tight "San Francisco"
  // beats a broad "San Francisco Bay Area, Greater Region".
  const valueTokens = new Set(tokenize(value));
  if (valueTokens.size === 0) return value;
  let best: { option: string; shared: number; coverage: number } | null = null;
  for (const o of options) {
    const optTokens = tokenize(o);
    if (!optTokens.length) continue;
    const shared = optTokens.filter((t) => valueTokens.has(t)).length;
    if (shared === 0) continue;
    const coverage = shared / optTokens.length;
    if (
      !best ||
      shared > best.shared ||
      (shared === best.shared && coverage > best.coverage)
    ) {
      best = { option: o, shared, coverage };
    }
  }
  return best ? best.option : value;
}

/**
 * Fallback contact-field resolver for labels that don't match a STANDARD_MAP key
 * verbatim (e.g. "Mobile phone number", "Your e-mail", "LinkedIn profile link").
 * Kept conservative — only fires on an unambiguous contact keyword so it never
 * hijacks an essay or custom question. This is why phone fields with verbose
 * labels were previously skipped and left blank.
 */
function fuzzyStandardKey(label: string): keyof PersonalProfile | undefined {
  if (/\b(phone|mobile|telephone|cell)\b/.test(label)) return "phone";
  if (/\be-?mail\b/.test(label)) return "email";
  if (/linkedin/.test(label)) return "linkedinUrl";
  if (/github/.test(label)) return "githubUrl";
  if (/google\s+scholar|\bscholar\b/.test(label)) return "scholarUrl";
  if (/\btwitter\b|\bx\.com\b|^x\b.*\b(url|profile|handle)\b/.test(label)) return "twitterUrl";
  if (/\bportfolio\b|personal\s+website|^website$/.test(label)) return "portfolioUrl";
  return undefined;
}

export function mapStandardFields(
  fields: DetectedField[],
  profile: Partial<PersonalProfile>,
  qaMemory: QaMemoryMap = {},
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
    // Voluntary EEO self-identification — fill from the profile when provided.
    // pushInstr resolves the stored value to the closest offered option (e.g.
    // "Asian" → "Asian (Not Hispanic or Latino)"), so verbose EEO labels still match.
    if (ETHNICITY_PATTERNS.some((p) => p.test(labelLower))) {
      if (profile.ethnicity && String(profile.ethnicity).trim()) {
        pushInstr(field, String(profile.ethnicity));
      }
      continue;
    }
    if (GENDER_PATTERNS.some((p) => p.test(labelLower))) {
      if (profile.gender && String(profile.gender).trim()) {
        pushInstr(field, String(profile.gender));
      }
      continue;
    }
    if (VETERAN_PATTERNS.some((p) => p.test(labelLower))) {
      if (profile.veteranStatus && String(profile.veteranStatus).trim()) {
        pushInstr(field, String(profile.veteranStatus));
      }
      continue;
    }
    if (DISABILITY_PATTERNS.some((p) => p.test(labelLower))) {
      if (profile.disabilityStatus && String(profile.disabilityStatus).trim()) {
        pushInstr(field, String(profile.disabilityStatus));
      }
      continue;
    }
    // Single full-name field (common on Ashby): combine first + last.
    if (/^(full |legal |your )?name$/.test(labelLower)) {
      const full = [profile.firstName, profile.lastName].filter(Boolean).join(" ").trim();
      if (full) pushInstr(field, full);
      continue;
    }

    // Single "Location" field (incl. "Current/Primary location", "Location (City)",
    // "Where are you based/located"): combine city/state/country. When the field is
    // a dropdown/combobox, pushInstr resolves the combined value (or its city head)
    // to the closest offered option via bestOptionMatch — so "San Francisco, CA, US"
    // selects the "San Francisco" choice instead of being left blank.
    if (
      /^(current\s+|primary\s+|your\s+)?location\b/.test(labelLower) ||
      /where.*(?:are you\s+)?(?:located|based)/.test(labelLower)
    ) {
      const loc = [profile.city, profile.state, profile.country].filter(Boolean).join(", ").trim();
      if (loc) pushInstr(field, loc);
      continue;
    }

    const profileKey = STANDARD_MAP[labelLower] ?? fuzzyStandardKey(labelLower);
    if (profileKey) {
      const value = profile[profileKey];
      if (value !== undefined && value !== null && String(value).trim() !== "") {
        pushInstr(field, String(value));
        continue;
      }
    }

    // Q&A memory: a question the user answered before (on this or another form).
    // Fill it automatically so we never ask the same thing twice.
    const remembered = qaMemory[normalizeLabel(field.label)];
    if (remembered && remembered.trim()) {
      pushInstr(field, remembered);
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
  qaMemory: QaMemoryMap = {},
): FillResult & { essayPromptBlock: string } {
  const instructions = mapStandardFields(fields, profile, qaMemory);
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
