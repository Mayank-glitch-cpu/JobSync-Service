import { readFileSync } from "node:fs";
import { fillAndSubmit, inspectForm, type FillInstruction } from "../lib/browser-apply.js";
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
            value:    { type: "string", description: "Value to enter / select / upload." },
            type: {
              type: "string",
              enum: ["text", "file", "select", "radio", "checkbox"],
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
    required: ["applyLink", "fields"],
    additionalProperties: false,
  },
  handler: async (args) => {
    try {
      const instructions = (args.fields as FillInstruction[]) ?? [];
      const dryRun = Boolean(args.dryRun ?? false);
      const result = await fillAndSubmit(String(args.applyLink), instructions, dryRun);
      return textResult(result);
    } catch (err) {
      return errorResult(String(err));
    }
  },
};
