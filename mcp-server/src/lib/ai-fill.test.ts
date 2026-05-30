import { describe, it, expect } from "vitest";
import { mapStandardFields, identifyEssayFields, buildEssayPromptBlock, fillFields } from "./ai-fill.js";
import type { DetectedField } from "./browser-apply.js";

// ─── shared fixtures ───────────────────────────────────────────────────────

// DetectedField requires placeholder + options; helper fills the defaults the
// browser detector would emit so fixtures stay focused on what each test cares about.
const field = (
  f: Pick<DetectedField, "selector" | "label" | "type" | "required"> & Partial<DetectedField>,
): DetectedField => ({ placeholder: "", options: [], ...f });

const basicFields: DetectedField[] = [
  field({ selector: "#first",   label: "First Name",    type: "text",  required: true  }),
  field({ selector: "#last",    label: "Last Name",     type: "text",  required: true  }),
  field({ selector: "#email",   label: "Email Address", type: "email", required: true  }),
  field({ selector: "#phone",   label: "Phone Number",  type: "tel",   required: false }),
  field({ selector: "#li",      label: "LinkedIn",      type: "text",  required: false }),
  field({ selector: "#gh",      label: "GitHub URL",    type: "text",  required: false }),
  field({ selector: "#port",    label: "Portfolio URL", type: "text",  required: false }),
  field({ selector: "#city",    label: "City",          type: "text",  required: false }),
  field({ selector: "#state",   label: "State",         type: "text",  required: false }),
  field({ selector: "#country", label: "Country",       type: "text",  required: false }),
];

const essayFields: DetectedField[] = [
  field({ selector: "#cover",  label: "Cover Letter",                  type: "textarea", required: false }),
  field({ selector: "#why",    label: "Why do you want to work here?", type: "textarea", required: false }),
  field({ selector: "#about",  label: "Tell us about yourself",        type: "textarea", required: false }),
  field({ selector: "#fit",    label: "Why are you a good fit?",       type: "textarea", required: false }),
  field({ selector: "#mot",    label: "What motivates you?",           type: "textarea", required: false }),
  field({ selector: "#bg",     label: "Describe your background",      type: "textarea", required: false }),
];

const radioFields: DetectedField[] = [
  field({ selector: "#auth", label: "Are you legally authorized to work in the US?", type: "radio", required: true, options: ["Yes", "No"] }),
  field({ selector: "#spon", label: "Do you require visa sponsorship?",              type: "radio", required: true, options: ["Yes", "No"] }),
];

const fileField: DetectedField[] = [
  field({ selector: "#resume", label: "Resume / CV", type: "file", required: true }),
];

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
      field({ selector: "#fn", label: "First Name*:", type: "text", required: true }),
    ];
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
      field({ selector: "#cover-sel", label: "Cover Letter", type: "select", required: false }),
    ];
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

  it("returns unfilledRequired for fields not mapped and not essays", () => {
    const unknownRequired: DetectedField[] = [
      field({ selector: "#grad", label: "Graduation Date", type: "text", required: true }),
    ];
    const { unfilledRequired } = fillFields(unknownRequired, profile, "Acme", "SWE", "exp", "skills", "projects");
    expect(unfilledRequired).toContain("Graduation Date");
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