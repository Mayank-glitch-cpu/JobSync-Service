import { describe, it, expect } from "vitest";
import {
  mapStandardFields,
  identifyEssayFields,
  buildEssayPromptBlock,
  fillFields,
  identifyUnansweredFields,
  buildAnswerPromptBlock,
} from "./ai-fill.js";
import type { UnansweredField } from "./ai-fill.js";
import type { DetectedField } from "./browser-apply.js";

// ─── shared fixtures ───────────────────────────────────────────────────────

// Build a DetectedField from the fields a test cares about, defaulting the
// rest (placeholder/options/required) so fixtures stay readable.
const field = (
  f: Pick<DetectedField, "selector" | "label" | "type"> & Partial<DetectedField>,
): DetectedField => ({ placeholder: "", required: false, options: [], ...f });

const basicFields: DetectedField[] = [
  { selector: "#first",   label: "First Name",    type: "text",     required: true  },
  { selector: "#last",    label: "Last Name",     type: "text",     required: true  },
  { selector: "#email",   label: "Email Address", type: "email",    required: true  },
  { selector: "#phone",   label: "Phone Number",  type: "tel",      required: false },
  { selector: "#li",      label: "LinkedIn",      type: "text",     required: false },
  { selector: "#gh",      label: "GitHub URL",    type: "text",     required: false },
  { selector: "#port",    label: "Portfolio URL", type: "text",     required: false },
  { selector: "#city",    label: "City",          type: "text",     required: false },
  { selector: "#state",   label: "State",         type: "text",     required: false },
  { selector: "#country", label: "Country",       type: "text",     required: false },
].map(field);

const essayFields: DetectedField[] = [
  { selector: "#cover",  label: "Cover Letter",                    type: "textarea", required: false },
  { selector: "#why",    label: "Why do you want to work here?",   type: "textarea", required: false },
  { selector: "#about",  label: "Tell us about yourself",          type: "textarea", required: false },
  { selector: "#fit",    label: "Why are you a good fit?",         type: "textarea", required: false },
  { selector: "#mot",    label: "What motivates you?",             type: "textarea", required: false },
  { selector: "#bg",     label: "Describe your background",        type: "textarea", required: false },
].map(field);

const radioFields: DetectedField[] = [
  { selector: "#auth",   label: "Are you legally authorized to work in the US?", type: "radio", required: true,  options: ["Yes", "No"] },
  { selector: "#spon",   label: "Do you require visa sponsorship?",               type: "radio", required: true,  options: ["Yes", "No"] },
].map(field);

const fileField: DetectedField[] = [
  { selector: "#resume", label: "Resume / CV",  type: "file", required: true },
].map(field);

const profile = {
  firstName:          "Prisha",
  lastName:           "Nag",
  email:              "pnag471@asu.edu",
  phone:              "555-867-5309",
  linkedinUrl:        "https://linkedin.com/in/prishanag",
  githubUrl:          "https://github.com/pnag471",
  portfolioUrl:       "https://prishanag.dev",
  city:               "Tempe",
  state:              "AZ",
  country:            "United States",
  workAuthorization:  "US citizen",
  requiresSponsorship: false,
  resumePath:         "/Users/prishanag/resume.pdf",
};

// ─── mapStandardFields ────────────────────────────────────────────────────

describe("mapStandardFields", () => {
  it("maps all basic personal fields", () => {
    const result = mapStandardFields(basicFields, profile);
    const bySelector = Object.fromEntries(result.map((r) => [r.selector, r.value]));

    expect(bySelector["#first"]).toBe("Prisha");
    expect(bySelector["#last"]).toBe("Nag");
    expect(bySelector["#email"]).toBe("pnag471@asu.edu");
    expect(bySelector["#phone"]).toBe("555-867-5309");
    expect(bySelector["#li"]).toBe("https://linkedin.com/in/prishanag");
    expect(bySelector["#gh"]).toBe("https://github.com/pnag471");
    expect(bySelector["#port"]).toBe("https://prishanag.dev");
    expect(bySelector["#city"]).toBe("Tempe");
    expect(bySelector["#state"]).toBe("AZ");
    expect(bySelector["#country"]).toBe("United States");
  });

  it("maps work authorization radio to Yes for a US citizen", () => {
    const result = mapStandardFields(radioFields, profile);
    const auth = result.find((r) => r.selector === "#auth");
    expect(auth?.value).toBe("Yes");
  });

  it("maps sponsorship radio to No when requiresSponsorship is false", () => {
    const result = mapStandardFields(radioFields, profile);
    const spon = result.find((r) => r.selector === "#spon");
    expect(spon?.value).toBe("No");
  });

  it("maps sponsorship radio to Yes when requiresSponsorship is true", () => {
    const result = mapStandardFields(radioFields, { ...profile, requiresSponsorship: true });
    const spon = result.find((r) => r.selector === "#spon");
    expect(spon?.value).toBe("Yes");
  });

  it("maps work authorization to No for an H1B holder", () => {
    const result = mapStandardFields(radioFields, { ...profile, workAuthorization: "H1B visa" });
    const auth = result.find((r) => r.selector === "#auth");
    expect(auth?.value).toBe("No");
  });

  it("maps resume file field from resumePath", () => {
    const result = mapStandardFields(fileField, profile);
    expect(result[0]?.value).toBe("/Users/prishanag/resume.pdf");
    expect(result[0]?.type).toBe("file");
  });

  it("skips resume field if resumePath is not in profile", () => {
    const { resumePath, ...profileWithoutResume } = profile;
    const result = mapStandardFields(fileField, profileWithoutResume);
    expect(result).toHaveLength(0);
  });

  it("skips fields where profile value is empty string", () => {
    const result = mapStandardFields(basicFields, { ...profile, city: "" });
    expect(result.find((r) => r.selector === "#city")).toBeUndefined();
  });

  it("handles label with asterisk and colon stripping", () => {
    const fields: DetectedField[] = [
      { selector: "#fn", label: "First Name*:", type: "text", required: true },
    ].map(field);
    const result = mapStandardFields(fields, profile);
    expect(result[0]?.value).toBe("Prisha");
  });

  it("does not map essay fields", () => {
    const result = mapStandardFields(essayFields, profile);
    expect(result).toHaveLength(0);
  });

  it("returns empty array when profile is empty", () => {
    const result = mapStandardFields(basicFields, {});
    expect(result).toHaveLength(0);
  });

  it("resolves a dropdown value to a real option (country USA → 'United States +1')", () => {
    const countrySelect: DetectedField[] = [
      { selector: "#country", label: "Country", type: "select", options: ["United States +1", "India +91", "Canada +1"] },
    ].map(field);
    const result = mapStandardFields(countrySelect, profile);
    expect(result.find((r) => r.selector === "#country")?.value).toBe("United States +1");
  });

  it("resolves a location dropdown to the closest option by token overlap", () => {
    // Profile location ("San Francisco, California, United States") does not match
    // any option verbatim, but shares tokens with "San Francisco, CA, USA".
    const locSelect: DetectedField[] = [
      {
        selector: "#loc",
        label: "Location",
        type: "select",
        options: ["New York, NY, USA", "San Francisco, CA, USA", "Austin, TX, USA"],
      },
    ].map(field);
    const sfProfile = { city: "San Francisco", state: "California", country: "United States" };
    const result = mapStandardFields(locSelect, sfProfile);
    expect(result.find((r) => r.selector === "#loc")?.value).toBe("San Francisco, CA, USA");
  });

  it("maps a phone field with a verbose label via the fuzzy fallback", () => {
    const fields: DetectedField[] = [
      { selector: "#ph", label: "Mobile phone number", type: "tel", required: true },
    ].map(field);
    const result = mapStandardFields(fields, profile);
    expect(result.find((r) => r.selector === "#ph")?.value).toBe("555-867-5309");
  });

  it("maps a 'Where are you located?' field as a combined location", () => {
    const fields: DetectedField[] = [
      { selector: "#loc", label: "Where are you located?", type: "text", required: false },
    ].map(field);
    const result = mapStandardFields(fields, profile);
    expect(result.find((r) => r.selector === "#loc")?.value).toBe("Tempe, AZ, United States");
  });

  it("does NOT force Yes/No work-auth onto a dropdown with richer options", () => {
    const workAuthSelect: DetectedField[] = [
      {
        selector: "#wa",
        label: "Your authorization to work in the country where you live.",
        type: "select",
        required: true,
        options: [
          "I am authorized to work in the country due to my nationality",
          "I am not authorized to work in the country and need visa support",
        ],
      },
    ].map(field);
    // Left unmapped so the agent picks the correct option from the harvested list.
    const result = mapStandardFields(workAuthSelect, profile);
    expect(result.find((r) => r.selector === "#wa")).toBeUndefined();
  });

  it("still maps a Yes/No work-auth/sponsorship dropdown", () => {
    const yesNo: DetectedField[] = [
      { selector: "#wa", label: "Are you authorized to work in the US?", type: "select", options: ["Yes", "No"] },
      { selector: "#sp", label: "Do you require visa sponsorship?", type: "select", options: ["Yes", "No"] },
    ].map(field);
    const result = mapStandardFields(yesNo, profile);
    expect(result.find((r) => r.selector === "#wa")?.value).toBe("Yes");
    expect(result.find((r) => r.selector === "#sp")?.value).toBe("No");
  });

  // ── single "Name" field (Ashby): combine first + last ───────────────────
  it("combines first + last into a single 'Name' field", () => {
    const nameField: DetectedField[] = [
      { selector: "#name", label: "Name", type: "text", required: true },
    ].map(field);
    const result = mapStandardFields(nameField, profile);
    expect(result.find((r) => r.selector === "#name")?.value).toBe("Prisha Nag");
  });

  it("combines first + last for 'Full Name' / 'Legal Name' / 'Your Name'", () => {
    for (const label of ["Full Name", "Legal Name", "Your Name"]) {
      const fields: DetectedField[] = [
        { selector: "#n", label, type: "text", required: true },
      ].map(field);
      const result = mapStandardFields(fields, profile);
      expect(result.find((r) => r.selector === "#n")?.value).toBe("Prisha Nag");
    }
  });

  it("does NOT treat 'First Name' / 'Last Name' as a combined name field", () => {
    // These must map to the individual profile keys, not the combined value.
    const result = mapStandardFields(basicFields, profile);
    expect(result.find((r) => r.selector === "#first")?.value).toBe("Prisha");
    expect(result.find((r) => r.selector === "#last")?.value).toBe("Nag");
  });

  it("skips the single 'Name' field when both names are absent", () => {
    const nameField: DetectedField[] = [
      { selector: "#name", label: "Name", type: "text", required: true },
    ].map(field);
    const result = mapStandardFields(nameField, { email: "x@y.com" });
    expect(result.find((r) => r.selector === "#name")).toBeUndefined();
  });

  // ── single "Location" field (Ashby): combine city/state/country ──────────
  it("combines city/state/country into a single 'Location' field", () => {
    const locField: DetectedField[] = [
      { selector: "#loc", label: "Location", type: "text", required: false },
    ].map(field);
    const result = mapStandardFields(locField, profile);
    expect(result.find((r) => r.selector === "#loc")?.value).toBe("Tempe, AZ, United States");
  });

  it("combines location for 'Current Location'", () => {
    const locField: DetectedField[] = [
      { selector: "#loc", label: "Current Location", type: "text", required: false },
    ].map(field);
    const result = mapStandardFields(locField, profile);
    expect(result.find((r) => r.selector === "#loc")?.value).toBe("Tempe, AZ, United States");
  });

  it("joins only the present location parts (no leading/trailing commas)", () => {
    const locField: DetectedField[] = [
      { selector: "#loc", label: "Location", type: "text", required: false },
    ].map(field);
    const result = mapStandardFields(locField, { city: "Tempe", country: "United States" });
    expect(result.find((r) => r.selector === "#loc")?.value).toBe("Tempe, United States");
  });

  it("skips the single 'Location' field when no location parts exist", () => {
    const locField: DetectedField[] = [
      { selector: "#loc", label: "Location", type: "text", required: false },
    ].map(field);
    const result = mapStandardFields(locField, { email: "x@y.com" });
    expect(result.find((r) => r.selector === "#loc")).toBeUndefined();
  });
});

// ─── identifyEssayFields ──────────────────────────────────────────────────

describe("identifyEssayFields", () => {
  it("identifies all essay-pattern fields", () => {
    const mapped = new Set<string>();
    const result = identifyEssayFields(essayFields, mapped);
    expect(result.map((f) => f.selector)).toEqual(
      expect.arrayContaining(["#cover", "#why", "#about", "#fit", "#mot", "#bg"])
    );
  });

  it("excludes fields that are already mapped", () => {
    const mapped = new Set(["#cover", "#why"]);
    const result = identifyEssayFields(essayFields, mapped);
    expect(result.find((f) => f.selector === "#cover")).toBeUndefined();
    expect(result.find((f) => f.selector === "#why")).toBeUndefined();
  });

  it("excludes non-textarea/text fields even if label matches", () => {
    const selectEssay: DetectedField[] = [
      { selector: "#cover-sel", label: "Cover Letter", type: "select", required: false },
    ].map(field);
    const result = identifyEssayFields(selectEssay, new Set());
    expect(result).toHaveLength(0);
  });

  it("does not flag standard text fields as essays", () => {
    const result = identifyEssayFields(basicFields, new Set());
    expect(result).toHaveLength(0);
  });

  it("returns empty array when all essay fields are already mapped", () => {
    const mapped = new Set(essayFields.map((f) => f.selector));
    const result = identifyEssayFields(essayFields, mapped);
    expect(result).toHaveLength(0);
  });
});

// ─── buildEssayPromptBlock ────────────────────────────────────────────────

describe("buildEssayPromptBlock", () => {
  const ctx = {
    company:    "Acme Corp",
    jobTitle:   "Software Engineer",
    experience: "2 years at PrintPapa building Flask dashboards",
    skills:     "Python, TypeScript, React, SQL",
    projects:   "SentinelEdge — on-device scam detection",
  };

  it("returns empty string when no essay fields", () => {
    expect(buildEssayPromptBlock([], ctx)).toBe("");
  });

  it("includes company and job title in output", () => {
    const fields = [{ selector: "#cover", label: "Cover Letter", type: "textarea" }];
    const block = buildEssayPromptBlock(fields, ctx);
    expect(block).toContain("Acme Corp");
    expect(block).toContain("Software Engineer");
  });

  it("includes each field label", () => {
    const fields = [
      { selector: "#cover", label: "Cover Letter",   type: "textarea" },
      { selector: "#why",   label: "Why Acme Corp?", type: "textarea" },
    ];
    const block = buildEssayPromptBlock(fields, ctx);
    expect(block).toContain("Cover Letter");
    expect(block).toContain("Why Acme Corp?");
  });

  it("includes profile context sections", () => {
    const fields = [{ selector: "#cover", label: "Cover Letter", type: "textarea" }];
    const block = buildEssayPromptBlock(fields, ctx);
    expect(block).toContain("PrintPapa");
    expect(block).toContain("SentinelEdge");
    expect(block).toContain("Python");
  });

  it("includes frameUrl in field list when present", () => {
    const fields = [{ selector: "#cover", label: "Cover Letter", type: "textarea", frameUrl: "https://boards.greenhouse.io/acme" }];
    const block = buildEssayPromptBlock(fields, ctx);
    expect(block).toContain("boards.greenhouse.io");
  });

  it("shows (not provided) when experience is empty", () => {
    const fields = [{ selector: "#cover", label: "Cover Letter", type: "textarea" }];
    const block = buildEssayPromptBlock(fields, { ...ctx, experience: "" });
    expect(block).toContain("(not provided)");
  });
});

// ─── fillFields (orchestrator) ────────────────────────────────────────────

describe("fillFields", () => {
  const allFields = [...basicFields, ...essayFields, ...radioFields, ...fileField];

  it("returns standard instructions for basic fields", () => {
    const { instructions } = fillFields(allFields, profile, "Acme", "SWE", "exp", "skills", "projects");
    expect(instructions.find((i) => i.selector === "#first")?.value).toBe("Prisha");
    expect(instructions.find((i) => i.selector === "#email")?.value).toBe("pnag471@asu.edu");
  });

  it("identifies essay fields separately", () => {
    const { essayFields: found } = fillFields(allFields, profile, "Acme", "SWE", "exp", "skills", "projects");
    expect(found.map((f) => f.selector)).toContain("#cover");
    expect(found.map((f) => f.selector)).toContain("#why");
  });

  it("essay fields are not in instructions", () => {
    const { instructions } = fillFields(allFields, profile, "Acme", "SWE", "exp", "skills", "projects");
    const selectors = instructions.map((i) => i.selector);
    expect(selectors).not.toContain("#cover");
    expect(selectors).not.toContain("#why");
  });

  it("surfaces unmapped non-file fields as unanswered (the agent must answer them)", () => {
    const unknownRequired: DetectedField[] = [
      { selector: "#grad", label: "Graduation Date", type: "text", required: true },
    ].map(field);
    const { unfilledRequired, unansweredFields } = fillFields(unknownRequired, profile, "Acme", "SWE", "exp", "skills", "projects");
    // It is answerable from the profile, so it is NOT a hard-blocked required field…
    expect(unfilledRequired).not.toContain("Graduation Date");
    // …it is surfaced for the agent to compose an answer.
    expect(unansweredFields.map((f) => f.selector)).toContain("#grad");
  });

  it("keeps a required unmapped file upload in unfilledRequired (not answerable)", () => {
    const orphanFile: DetectedField[] = [
      { selector: "#transcript", label: "Upload Transcript", type: "file", required: true },
    ].map(field);
    const { unfilledRequired, unansweredFields } = fillFields(orphanFile, profile, "Acme", "SWE", "exp", "skills", "projects");
    expect(unfilledRequired).toContain("Upload Transcript");
    expect(unansweredFields.map((f) => f.selector)).not.toContain("#transcript");
  });

  it("returns empty unfilledRequired when all required fields are covered", () => {
    const { unfilledRequired } = fillFields(basicFields, profile, "Acme", "SWE", "exp", "skills", "projects");
    expect(unfilledRequired).toHaveLength(0);
  });

  it("returns a non-empty essayPromptBlock when essay fields exist", () => {
    const { essayPromptBlock } = fillFields(essayFields, profile, "Acme", "SWE", "exp", "skills", "projects");
    expect(essayPromptBlock.length).toBeGreaterThan(0);
    expect(essayPromptBlock).toContain("Acme");
  });

  it("returns empty essayPromptBlock when no essay fields", () => {
    const { essayPromptBlock } = fillFields(basicFields, profile, "Acme", "SWE", "exp", "skills", "projects");
    expect(essayPromptBlock).toBe("");
  });
});

// ─── identifyUnansweredFields ─────────────────────────────────────────────
// The hard rule: EVERY asked field that standard mapping didn't fill (and isn't a
// file upload) must be surfaced for the agent to compose an answer.

describe("identifyUnansweredFields", () => {
  it("surfaces an unmapped non-file field (the agent must answer it)", () => {
    const fields: DetectedField[] = [
      { selector: "#grad", label: "Graduation Date", type: "text", required: true },
    ].map(field);
    const result = identifyUnansweredFields(fields, new Set());
    expect(result.map((f) => f.selector)).toContain("#grad");
  });

  it("excludes fields already mapped by the standard mapper", () => {
    const fields: DetectedField[] = [
      { selector: "#grad", label: "Graduation Date", type: "text", required: true },
      { selector: "#hear", label: "How did you hear about us?", type: "text", required: false },
    ].map(field);
    const result = identifyUnansweredFields(fields, new Set(["#grad"]));
    expect(result.map((f) => f.selector)).toEqual(["#hear"]);
  });

  it("never surfaces file uploads (those are not agent-answerable)", () => {
    const fields: DetectedField[] = [
      { selector: "#transcript", label: "Upload Transcript", type: "file", required: true },
    ].map(field);
    const result = identifyUnansweredFields(fields, new Set());
    expect(result).toHaveLength(0);
  });

  it("preserves type, required and options so the agent can pick a valid choice", () => {
    const fields: DetectedField[] = [
      {
        selector: "#wa",
        label: "Work authorization",
        type: "select",
        required: true,
        options: ["Authorized", "Need sponsorship"],
      },
    ].map(field);
    const [f] = identifyUnansweredFields(fields, new Set());
    expect(f).toBeDefined();
    expect(f!.type).toBe("select");
    expect(f!.required).toBe(true);
    expect(f!.options).toEqual(["Authorized", "Need sponsorship"]);
  });

  it("carries frameUrl through when present (Greenhouse iframe forms)", () => {
    const fields: DetectedField[] = [
      {
        selector: "#why",
        label: "Custom question",
        type: "textarea",
        frameUrl: "https://boards.greenhouse.io/acme",
      },
    ].map(field);
    const [f] = identifyUnansweredFields(fields, new Set());
    expect(f).toBeDefined();
    expect(f!.frameUrl).toBe("https://boards.greenhouse.io/acme");
  });

  it("does NOT set frameUrl key when the source field has none", () => {
    const fields: DetectedField[] = [
      { selector: "#x", label: "Some question", type: "text" },
    ].map(field);
    const [f] = identifyUnansweredFields(fields, new Set());
    expect(f).toBeDefined();
    expect("frameUrl" in f!).toBe(false);
  });
});

// ─── buildAnswerPromptBlock ───────────────────────────────────────────────

describe("buildAnswerPromptBlock", () => {
  const ctx = {
    company: "Acme Corp",
    jobTitle: "Software Engineer",
    experience: "2 years at PrintPapa",
    skills: "Python, TypeScript",
    projects: "SentinelEdge",
  };

  const mkUnanswered = (f: Partial<UnansweredField>): UnansweredField => ({
    selector: "#x",
    label: "Some question",
    type: "text",
    required: false,
    options: [],
    ...f,
  });

  it("returns empty string when there are no unanswered fields", () => {
    expect(buildAnswerPromptBlock([], ctx)).toBe("");
  });

  it("states the hard rule to answer every field", () => {
    const block = buildAnswerPromptBlock([mkUnanswered({})], ctx);
    expect(block).toMatch(/answer EVERY field/i);
  });

  it("lists each field label and marks required fields", () => {
    const block = buildAnswerPromptBlock(
      [
        mkUnanswered({ selector: "#grad", label: "Graduation Date", required: true }),
        mkUnanswered({ selector: "#hear", label: "How did you hear about us?", required: false }),
      ],
      ctx,
    );
    expect(block).toContain("Graduation Date");
    expect(block).toContain("How did you hear about us?");
    expect(block).toMatch(/Graduation Date\*\* \*\*\(required\)\*\*/);
  });

  it("renders the option list so the agent picks an offered choice", () => {
    const block = buildAnswerPromptBlock(
      [mkUnanswered({ selector: "#wa", label: "Work authorization", type: "select", options: ["Authorized", "Need sponsorship"] })],
      ctx,
    );
    expect(block).toContain("Authorized | Need sponsorship");
  });

  it("includes profile context and the target company/role", () => {
    const block = buildAnswerPromptBlock([mkUnanswered({})], ctx);
    expect(block).toContain("Acme Corp");
    expect(block).toContain("Software Engineer");
    expect(block).toContain("PrintPapa");
    expect(block).toContain("SentinelEdge");
  });

  it("includes frameUrl in the field line when present", () => {
    const block = buildAnswerPromptBlock(
      [mkUnanswered({ frameUrl: "https://boards.greenhouse.io/acme" })],
      ctx,
    );
    expect(block).toContain("boards.greenhouse.io");
  });

  it("shows (not provided) for empty profile context", () => {
    const block = buildAnswerPromptBlock([mkUnanswered({})], { ...ctx, experience: "", skills: "", projects: "" });
    expect(block).toContain("(not provided)");
  });
});