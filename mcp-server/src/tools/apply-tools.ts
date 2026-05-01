import { readFileSync } from "node:fs";
import {
  fillAndSubmit,
  inspectForm,
  loadFormState,
  saveApplyDraft,
  type FillInstruction,
  type PreviewField,
} from "../lib/browser-apply.js";
import { readPersonalProfile, writePersonalProfile, type PersonalProfile } from "../lib/personal-profile.js";
import { errorResult, textResult, type ContentBlock, type ToolDefinition, type ToolResult } from "./index.js";

export const profileWritePersonalTool: ToolDefinition = {
  name: "profile_write_personal",
  description:
    "Save or update the user's personal contact info used for auto-apply form filling. " +
    "Stored at ~/.jobsync/profile/personal.json. Call this once during onboarding. " +
    "Fields: firstName, lastName, email, phone, linkedinUrl, githubUrl, portfolioUrl, " +
    "workAuthorization (e.g. 'OPT' | 'CPT' | 'H1B Visa' | 'Green Card' | 'US Citizen'), " +
    "requiresSponsorship (bool), resumePath (absolute path to PDF/DOCX resume), " +
    "city, state, country. ⚡ [Model hint: haiku]",
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
    },
    additionalProperties: false,
  },
  handler: async (args) => {
    try {
      const updated = writePersonalProfile(args as Partial<PersonalProfile>);
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
      const profile = readPersonalProfile();
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
      return textResult({
        saved: true,
        draftFieldCount: instructions.length,
        preview,
        url: state.url,
        atsHint: state.atsHint,
      });
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
    "On success, call pipeline_mark_applied with the applyLink. ⚙ [Model hint: sonnet]",
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
