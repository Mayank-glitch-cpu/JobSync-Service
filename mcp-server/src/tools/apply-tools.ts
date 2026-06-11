import { readFileSync } from "node:fs";
import {
  fillAndSubmit,
  inspectForm,
  loadFormState,
  saveApplyDraft,
  submitEmailCode,
  closeApplySession,
  type FillInstruction,
  type PreviewField,
} from "../lib/browser-apply.js";
import { readPersonalProfile, writePersonalProfile, type PersonalProfile } from "../lib/personal-profile.js";
import { readProfileFile } from "../lib/profile.js";
import { fillFields, ESSAY_PATTERNS } from "../lib/ai-fill.js";
import { errorResult, textResult, type ContentBlock, type ToolDefinition, type ToolResult } from "./index.js";

function renderPreviewTable(
  preview: PreviewField[],
  unfilledRequired: string[],
  resumePath?: string,
): string {
  const rows = preview.map((p) => {
    const val =
      p.type === "file"
        ? p.value
        : p.value.length > 120
          ? p.value.slice(0, 120) + "…"
          : p.value;
    return `| ${p.field} | ${val} |`;
  });

  for (const label of unfilledRequired) {
    rows.push(`| ⚠️ ${label} | needs review |`);
  }

  const table = ["| Field | Value |", "|-------|-------|", ...rows].join("\n");
  const resumeLine = resumePath ? `\nResume: \`${resumePath}\` ✓ attached` : "";

  return (
    `Here is what will be submitted (FYI — auto-apply will fill and submit this automatically; no confirmation needed).\n\n` +
    table +
    resumeLine
  );
}

export const profileWritePersonalTool: ToolDefinition = {
  name: "profile_write_personal",
  description:
    "Save or update the user's personal contact info used for auto-apply form filling. " +
    "Stored at ~/.jobsync/profile/personal.json. Call this once during onboarding. " +
    "Fields: firstName, lastName, email, phone, linkedinUrl, githubUrl, portfolioUrl, " +
    "workAuthorization (e.g. 'OPT' | 'CPT' | 'H1B Visa' | 'Green Card' | 'US Citizen'), " +
    "requiresSponsorship (bool), resumePath (absolute path to PDF/DOCX resume), " +
    "city, state, country, and voluntary EEO self-identification: ethnicity (e.g. 'Asian'), " +
    "veteranStatus ('Yes' | 'No' | 'Decline to self-identify'), " +
    "disabilityStatus ('Yes' | 'No' | 'Decline to self-identify'), disabilityDetails (if disabilityStatus is 'Yes'). " +
    "⚡ [Model hint: haiku]",
  recommendedModel: "haiku",
  inputSchema: {
    type: "object",
    properties: {
      firstName:            { type: "string" },
      lastName:             { type: "string" },
      email:                { type: "string" },
      phone:                { type: "string" },
      linkedinUrl:          { type: "string" },
      githubUrl:            { type: "string" },
      portfolioUrl:         { type: "string" },
      workAuthorization:    { type: "string" },
      requiresSponsorship:  { type: "boolean" },
      resumePath:           { type: "string", description: "Absolute path to resume PDF or DOCX." },
      city:                 { type: "string" },
      state:                { type: "string" },
      country:              { type: "string" },
      ethnicity:            { type: "string", description: "Voluntary race/ethnicity self-ID, e.g. 'Asian', 'White', 'Hispanic or Latino', 'Decline to self-identify'." },
      veteranStatus:        { type: "string", description: "Protected-veteran self-ID: 'Yes' | 'No' | 'Decline to self-identify'." },
      disabilityStatus:     { type: "string", description: "Disability self-ID: 'Yes' | 'No' | 'Decline to self-identify'." },
      disabilityDetails:    { type: "string", description: "Optional description of the disability when disabilityStatus is 'Yes'." },
    },
    additionalProperties: false,
  },
  handler: async (args) => {
    try {
      const updated = await writePersonalProfile(args as Partial<PersonalProfile>);
      return textResult({ saved: true, profile: updated });
    } catch (err) {
      return errorResult(String(err));
    }
  },
};

export const profileReadPersonalTool: ToolDefinition = {
  name: "profile_read_personal",
  description:
    "Read the user's personal contact info from ~/.jobsync/profile/personal.json. " +
    "Used by the auto-apply workflow to populate form fields. ⚡ [Model hint: haiku]",
  recommendedModel: "haiku",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  handler: async () => {
    try {
      const profile = await readPersonalProfile();
      const missing: string[] = [];
      for (const key of ["firstName", "lastName", "email", "resumePath"] as const) {
        if (!profile[key]) missing.push(key);
      }
      return textResult({ profile, missing });
    } catch (err) {
      return errorResult(String(err));
    }
  },
};

export const applyLoadStateTool: ToolDefinition = {
  name: "apply_load_state",
  description:
    "Load the saved form state from the last apply_inspect_form call (~/.jobsync/apply-state.json). " +
    "Use this when the user confirms after previewing — it returns the previously detected fields and URL " +
    "without re-opening the browser. State expires after 2 hours. ⚡ [Model hint: haiku]",
  recommendedModel: "haiku",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  handler: async (): Promise<ToolResult> => {
    const state = loadFormState();
    if (!state) {
      return errorResult(
        "No saved form state found (or it has expired). Run apply_inspect_form first.",
      );
    }
    return textResult(state);
  },
};

export const applySaveDraftTool: ToolDefinition = {
  name: "apply_save_draft",
  description:
    "Persist mapped fill instructions and preview rows after inspection and AI answer generation. " +
    "Call this before showing the pre-submit preview table, so a later 'yes' or 'apply' can submit the same saved values. " +
    "apply_submit_form can then be called without fields to reuse this draft. [Model hint: haiku]",
  recommendedModel: "haiku",
  inputSchema: {
    type: "object",
    properties: {
      applyLink: {
        type: "string",
        description: "Original apply URL. Used if no inspected form URL is already stored.",
      },
      fields: {
        type: "array",
        description: "Fill instructions derived from inspect output, personal profile, and AI-generated answers.",
        items: {
          type: "object",
          properties: {
            selector: { type: "string", description: "CSS selector from inspect output, or a visible field label." },
            label: { type: "string", description: "Human-readable field label for preview and fallback matching." },
            frameUrl: { type: "string", description: "Frame URL from inspect output, if present." },
            value: { type: "string", description: "Value to enter / select / upload." },
            type: {
              type: "string",
              enum: ["text", "file", "select", "radio", "checkbox", "textarea"],
              description: "How to set the field. Defaults to text.",
            },
          },
          required: ["selector", "value"],
        },
      },
      preview: {
        type: "array",
        description: "Rows for the in-chat preview table. If omitted, the tool derives them from fields.",
        items: {
          type: "object",
          properties: {
            field: { type: "string" },
            value: { type: "string" },
            type: { type: "string" },
          },
          required: ["field", "value"],
        },
      },
    },
    required: ["fields"],
    additionalProperties: false,
  },
  handler: async (args): Promise<ToolResult> => {
    try {
      const instructions = (args.fields as FillInstruction[]) ?? [];
      const preview =
        (args.preview as PreviewField[] | undefined) ??
        instructions.map((field) => ({
          field: field.label || field.selector,
          value: field.type === "file" ? field.value : String(field.value ?? "").slice(0, 300),
          type: field.type,
        }));
      const state = saveApplyDraft(instructions, preview, args.applyLink ? String(args.applyLink) : undefined);

      const resumeInstruction = instructions.find((f) => f.type === "file");
      // Re-derive missing required fields from the persisted form state: any detected
      // required field that no instruction targets is still unfilled at save time.
      const unfilledRequired = state.fields
        .filter((f) => f.required && !instructions.some((i) => i.selector === f.selector))
        .map((f) => f.label);
      const markdown = renderPreviewTable(preview, unfilledRequired, resumeInstruction?.value);

      return {
        content: [
          { type: "text", text: JSON.stringify({ saved: true, draftFieldCount: instructions.length, url: state.url, atsHint: state.atsHint }, null, 2) },
          { type: "text", text: markdown },
        ],
      };
    } catch (err) {
      return errorResult(String(err));
    }
  },
};

export const applyInspectFormTool: ToolDefinition = {
  name: "apply_inspect_form",
  description:
    "Open a Chromium browser (headed), navigate to the job application URL, and return the detected " +
    "form fields (label, selector, type, options, required). Also returns a screenshot path and an ATS hint " +
    "(greenhouse | lever | ashby | workday | unknown). " +
    "Call this FIRST in the auto-apply workflow so you know what fields to fill. " +
    "After inspecting, map the fields to the user's personal profile and call apply_submit_form. " +
    "⚙ [Model hint: sonnet]",
  recommendedModel: "sonnet",
  inputSchema: {
    type: "object",
    properties: {
      applyLink: { type: "string", description: "Direct URL to the job application form." },
    },
    required: ["applyLink"],
    additionalProperties: false,
  },
  handler: async (args): Promise<ToolResult> => {
    try {
      const result = await inspectForm(String(args.applyLink));
      const blocks: ContentBlock[] = [
        { type: "text", text: JSON.stringify(result, null, 2) },
      ];
      // Embed screenshot so the LLM can visually analyze the form (vision-based field detection)
      try {
        const imgData = readFileSync(result.screenshotPath).toString("base64");
        blocks.push({ type: "image", data: imgData, mimeType: "image/png" });
      } catch { /* screenshot missing — skip */ }
      return { content: blocks };
    } catch (err) {
      return errorResult(String(err));
    }
  },
};

export const applySubmitFormTool: ToolDefinition = {
  name: "apply_submit_form",
  description:
    "Fill and optionally submit a job application form in Chromium. " +
    "Provide an array of fill instructions — each with a CSS selector (from apply_inspect_form output) " +
    "and the value to enter. Type can be: 'text' (default), 'file' (resume upload — value is absolute file path), " +
    "'select' (value is the option label text), 'radio' (value is partial label text to match), " +
    "'checkbox' (value is 'true' or 'false'). " +
    "Set dryRun=true to fill but NOT submit (returns a screenshot for review). " +
    "This REUSES the same live browser session opened by apply_inspect_form — it does NOT relaunch or " +
    "re-navigate, and fields already filled keep their values. " +
    "If the result is not success (success:false, or submitted:true with no confirmation, or a non-empty " +
    "validationErrors/failedFields), the form did NOT go through but sessionOpen stays true: read validationErrors " +
    "(label, selector, message) and the screenshot to see which field was missed (often phone or a location/dropdown), " +
    "recompose ONLY those fields, call apply_save_draft, and call apply_submit_form again — the same open page is " +
    "corrected in place (only the changed fields are re-entered), saving tokens. " +
    "If the result has needsEmailCode:true, the form wants a verification code emailed to the user — ask the user for " +
    "the code and call apply_submit_code with it (do NOT relaunch). " +
    "On success the session closes automatically; call pipeline_mark_applied with the applyLink. ⚙ [Model hint: sonnet]",
  recommendedModel: "sonnet",
  inputSchema: {
    type: "object",
    properties: {
      applyLink: {
        type: "string",
        description: "Same URL used in apply_inspect_form.",
      },
      fields: {
        type: "array",
        description: "Fill instructions derived from inspect output + user profile.",
        items: {
          type: "object",
          properties: {
            selector: { type: "string", description: "CSS selector from inspect output." },
            label: { type: "string", description: "Human-readable label used as a fallback if selector matching fails." },
            frameUrl: { type: "string", description: "Frame URL from inspect output, if present." },
            value:    { type: "string", description: "Value to enter / select / upload." },
            type: {
              type: "string",
              enum: ["text", "file", "select", "radio", "checkbox", "textarea"],
              description: "How to set the field. Defaults to 'text'.",
            },
          },
          required: ["selector", "value"],
        },
      },
      dryRun: {
        type: "boolean",
        description: "If true, fill the form but do NOT click Submit. Returns a screenshot for review. Default false.",
      },
    },
    required: ["applyLink"],
    additionalProperties: false,
  },
  handler: async (args) => {
    try {
      const instructions = (args.fields as FillInstruction[] | undefined) ?? [];
      const dryRun = Boolean(args.dryRun ?? false);
      const result = await fillAndSubmit(String(args.applyLink), instructions, dryRun);
      return textResult(result);
    } catch (err) {
      return errorResult(String(err));
    }
  },
};

export const applyFillFieldsTool: ToolDefinition = {
  name: "apply_fill_fields",
  description:
    "Map the detected form fields to the user's personal profile and generate AI-fill instructions. " +
    "Call this after apply_inspect_form. It reads personal.json (contact fields), experience.md, skills.md, " +
    "and projects.md, maps all standard fields deterministically, and returns a block listing EVERY field the " +
    "profile did not fill (open-text essays AND structured questions like selects, radios, graduation date, " +
    "'how did you hear about us') that the agent must compose answers for from the profile. Returns a Markdown " +
    "preview table. After composing every answer, call apply_save_draft with the complete fields array " +
    "(standard + all answers), then call apply_submit_form to fill and submit automatically — do NOT wait for " +
    "user confirmation. ⚙ [Model hint: sonnet]",
  recommendedModel: "sonnet",
  inputSchema: {
    type: "object",
    properties: {
      applyLink: {
        type: "string",
        description: "The apply URL used in apply_inspect_form. Used to associate the draft with the right state.",
      },
      company: {
        type: "string",
        description: "Company name — used to personalise AI-generated essay answers.",
      },
      jobTitle: {
        type: "string",
        description: "Job title — used to personalise AI-generated essay answers.",
      },
    },
    required: ["applyLink"],
    additionalProperties: false,
  },
  handler: async (args): Promise<ToolResult> => {
    try {
      const state = loadFormState();
      if (!state) {
        return errorResult(
          "No saved form state found (or it has expired). Run apply_inspect_form first.",
        );
      }

      const [profile, experience, skills, projects] = await Promise.all([
        readPersonalProfile(),
        readProfileFile("experience"),
        readProfileFile("skills"),
        readProfileFile("projects"),
      ]);

      const company = args.company ? String(args.company) : "the company";
      const jobTitle = args.jobTitle ? String(args.jobTitle) : "this role";

      const { instructions, unansweredFields, unfilledRequired, essayPromptBlock } = fillFields(
        state.fields,
        profile,
        company,
        jobTitle,
        experience,
        skills,
        projects,
      );

      // Save the standard-mapped draft so apply_submit_form can load it even if essays are skipped.
      const preview = instructions.map((instr) => ({
        field: instr.label || instr.selector,
        value: instr.type === "file" ? instr.value : String(instr.value ?? "").slice(0, 300),
        type: instr.type,
      }));
      saveApplyDraft(instructions, preview, String(args.applyLink));

      const resumeInstruction = instructions.find((f) => f.type === "file");
      const previewTable = renderPreviewTable(
        preview as PreviewField[],
        unfilledRequired,
        resumeInstruction?.value,
      );

      const blocks: ContentBlock[] = [
        {
          type: "text",
          text: JSON.stringify(
            {
              standardFieldCount: instructions.length,
              unansweredFieldCount: unansweredFields.length,
              essayFieldCount: state.fields.filter((f) =>
                ESSAY_PATTERNS.some((p) => p.test(f.label)),
              ).length,
              unfilledRequired,
              url: state.url,
              atsHint: state.atsHint,
            },
            null,
            2,
          ),
        },
        { type: "text", text: previewTable },
      ];

      if (essayPromptBlock) {
        blocks.push({ type: "text", text: essayPromptBlock });
      }

      return { content: blocks };
    } catch (err) {
      return errorResult(String(err));
    }
  },
};

export const applySubmitCodeTool: ToolDefinition = {
  name: "apply_submit_code",
  description:
    "Enter an email/SMS verification code into the SAME live application browser session (the one left open " +
    "when apply_submit_form returned needsEmailCode:true). " +
    "Call with NO code (or code:\"auto\") to auto-fetch the code from the applicant's inbox over IMAP — prefer this " +
    "when email-code auto-fetch is configured; only pass an explicit `code` when the user gives you one or auto-fetch failed. " +
    "The code is typed into the open page and the verify/continue button is clicked — no relaunch, no refilling. " +
    "If success:true, the application completed (call pipeline_mark_applied). If success:false with needsEmailCode:true, " +
    "auto-fetch hasn't found it yet — retry this tool (no code) or ask the user. If sessionOpen:true with an error, " +
    "the code was wrong or more steps remain — show the screenshot and ask again. ⚙ [Model hint: sonnet]",
  recommendedModel: "sonnet",
  inputSchema: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description:
          "The verification code the user received by email or SMS. Omit (or pass \"auto\") to auto-fetch it from the applicant's inbox.",
      },
    },
    additionalProperties: false,
  },
  handler: async (args): Promise<ToolResult> => {
    try {
      const raw = args.code === undefined ? undefined : String(args.code).trim();
      const result = await submitEmailCode(raw);
      return textResult(result);
    } catch (err) {
      return errorResult(String(err));
    }
  },
};

export const applyCloseSessionTool: ToolDefinition = {
  name: "apply_close_session",
  description:
    "Close the live application browser session and free its resources. Call this if the user abandons an " +
    "auto-apply that left a session open (e.g. after repeated failures, or when they say to stop). On a confirmed " +
    "submission the session closes itself, so you normally do NOT need this. ⚡ [Model hint: haiku]",
  recommendedModel: "haiku",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  handler: async (): Promise<ToolResult> => {
    try {
      await closeApplySession();
      return textResult({ closed: true });
    } catch (err) {
      return errorResult(String(err));
    }
  },
};
