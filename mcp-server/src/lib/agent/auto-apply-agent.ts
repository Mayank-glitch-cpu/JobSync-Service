// Server-side Auto-Apply agent (preview-then-approve, one job at a time).
//
// prepareApplication() opens the application form in a live browser session,
// maps standard fields from the user's profile, asks Claude to compose answers
// for the remaining questions, fills everything as a DRY RUN (nothing submitted),
// and captures screenshots so the dashboard can show an "applying preview". The
// session is left OPEN, awaiting the user's approval.
//
// submitPreparedApplication() performs the real submit on that same open session
// (so nothing is re-typed) and marks the pipeline job applied on success.
// discardPreparedApplication() tears the session down without submitting.
//
// Because the browser session is a process-wide singleton (see browser-apply.ts),
// only one application can be prepared/awaiting approval at a time.

import type Anthropic from "@anthropic-ai/sdk";
import {
  closeApplySession,
  fillAndSubmit,
  inspectForm,
  patchDraftInstruction,
  readDraftInstruction,
  saveApplyDraft,
  type FillInstruction,
} from "../browser-apply.js";
import { fillFields, type UnansweredField } from "../ai-fill.js";
import { readPersonalProfile } from "../personal-profile.js";
import { readProfileFile } from "../profile.js";
import { markApplied } from "../pipeline.js";
import { screenshotToData } from "../gcs.js";
import { agentModel, getAnthropic, isAgentConfigured } from "./anthropic.js";

export interface ApplyParams {
  applyLink: string;
  /** Pipeline entry id — not strictly needed (we mark applied by link) but kept for context. */
  jobId?: string;
  company?: string;
  jobTitle?: string;
}

export interface PreviewFrame {
  stage: "inspect" | "filled" | "submitted" | "error";
  caption: string;
  url?: string;
  base64?: string;
  at: string;
}

export interface ProposedField {
  /** CSS selector the value targets — the key for tweak/edit operations. */
  selector: string;
  label: string;
  value: string;
  type: string;
  required: boolean;
  /** True when the answer was AI-composed (open text) and can be re-tweaked. */
  editable: boolean;
}

/** A one-word rewrite intent for an AI-composed answer, plus freeform fallback. */
export type TweakTransform = "formal" | "shorten" | "humanize" | "informal" | "more-facts" | string;

export interface PreparedApplication {
  applyLink: string;
  atsHint: string;
  pageTitle: string;
  filled: ProposedField[];
  /** Required fields that could not be answered — the user should resolve these before submitting. */
  unfilledRequired: string[];
  totalFields: number;
}

export interface SubmitOutcome {
  success: boolean;
  confirmedText: string;
  error?: string;
}

type ProgressSink = (message: string) => void;
type PreviewSink = (frame: PreviewFrame) => void;

const noopProgress: ProgressSink = () => {};
const noopPreview: PreviewSink = () => {};

async function frame(stage: PreviewFrame["stage"], caption: string, path: string): Promise<PreviewFrame> {
  const data = await screenshotToData(path).catch(() => ({}));
  return { stage, caption, at: new Date().toISOString(), ...data };
}

/** Mask the value shown for previews so we never echo a resume path or huge essay. */
function displayValue(instr: FillInstruction): string {
  if (instr.type === "file") return "(resume file)";
  const v = (instr.value ?? "").replace(/\s+/g, " ").trim();
  return v.length > 140 ? `${v.slice(0, 140)}…` : v;
}

// One Claude call to answer every field standard mapping left blank. Returns
// fill instructions keyed by the field selector; fields the model omits are simply
// left unanswered (and surface as unfilledRequired if required).
async function composeAnswers(
  unanswered: UnansweredField[],
  ctx: { company: string; jobTitle: string; experience: string; skills: string; projects: string },
): Promise<FillInstruction[]> {
  const client = await getAnthropic();

  const fieldList = unanswered
    .map((f, i) => {
      const req = f.required ? " (required)" : "";
      const opts = f.options.length ? ` — choose exactly one of: [${f.options.join(" | ")}]` : "";
      return `${i + 1}. selector=${JSON.stringify(f.selector)} | type=${f.type}${req} | label="${f.label}"${opts}`;
    })
    .join("\n");

  const system =
    "You fill job application fields on behalf of an applicant. For each field, produce the value to enter, grounded ONLY in the applicant's profile. " +
    "For select/radio/checkbox fields you MUST pick one of the offered options verbatim. For open text, write a genuine first-person answer (1-3 sentences for short prompts, 150-300 words for cover letters). " +
    "Never fabricate credentials. If a fact is truly absent, choose a reasonable non-fabricated value. Return an answer for every field.";

  const prompt = `Applicant profile:
Experience:
${ctx.experience || "(not provided)"}

Skills:
${ctx.skills || "(not provided)"}

Projects:
${ctx.projects || "(not provided)"}

Target: ${ctx.jobTitle || "this role"} at ${ctx.company || "the company"}.

Fields to answer:
${fieldList}

Return JSON: an object {"answers":[{"selector": <string>, "value": <string>}, ...]} with one entry per field above, using the exact selector strings.`;

  const schema = {
    type: "object",
    properties: {
      answers: {
        type: "array",
        items: {
          type: "object",
          properties: { selector: { type: "string" }, value: { type: "string" } },
          required: ["selector", "value"],
          additionalProperties: false,
        },
      },
    },
    required: ["answers"],
    additionalProperties: false,
  } as const;

  const resp = await client.messages.create({
    model: agentModel(),
    max_tokens: 8000,
    system,
    output_config: { format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: prompt }],
  });

  const text = resp.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  let answers: Array<{ selector: string; value: string }> = [];
  try {
    answers = (JSON.parse(text) as { answers?: Array<{ selector: string; value: string }> }).answers ?? [];
  } catch {
    return [];
  }

  const bySelector = new Map(unanswered.map((f) => [f.selector, f]));
  const instructions: FillInstruction[] = [];
  for (const a of answers) {
    const field = bySelector.get(a.selector);
    if (!field || !a.value?.trim()) continue;
    instructions.push({
      selector: field.selector,
      label: field.label,
      value: a.value,
      type: field.type as FillInstruction["type"],
      ...(field.frameUrl ? { frameUrl: field.frameUrl } : {}),
    });
  }
  return instructions;
}

/**
 * Open the form, fill it from profile + composed answers as a DRY RUN, and leave
 * the session open awaiting approval. Emits progress lines and screenshot previews.
 */
export async function prepareApplication(
  uid: string,
  params: ApplyParams,
  onProgress: ProgressSink = noopProgress,
  onPreview: PreviewSink = noopPreview,
): Promise<PreparedApplication> {
  const applyLink = params.applyLink;
  const company = params.company ?? "the company";
  const jobTitle = params.jobTitle ?? "this role";

  const [personal, experience, skills, projects] = await Promise.all([
    readPersonalProfile(uid),
    readProfileFile("experience", uid),
    readProfileFile("skills", uid),
    readProfileFile("projects", uid),
  ]);

  onProgress(`Opening application form for ${jobTitle} at ${company}…`);
  const inspect = await inspectForm(applyLink);
  onPreview(await frame("inspect", "Application form opened", inspect.screenshotPath));
  onProgress(`Detected ${inspect.fields.length} field(s) on a ${inspect.atsHint} form.`);

  const fill = fillFields(inspect.fields, personal, company, jobTitle, experience, skills, projects);
  const instructions: FillInstruction[] = [...fill.instructions];
  onProgress(`Mapped ${instructions.length} field(s) from your profile.`);

  // Selectors whose value was written by Claude (open text/textarea) — only these
  // are surfaced as "editable" so the UI offers tweak buttons for them.
  const composedSelectors = new Set<string>();

  if (fill.unansweredFields.length > 0) {
    if (isAgentConfigured()) {
      onProgress(`Composing answers for ${fill.unansweredFields.length} remaining question(s)…`);
      try {
        const composed = await composeAnswers(fill.unansweredFields, {
          company,
          jobTitle,
          experience,
          skills,
          projects,
        });
        instructions.push(...composed);
        for (const c of composed) composedSelectors.add(c.selector);
        onProgress(`Composed ${composed.length} answer(s).`);
      } catch (err) {
        onProgress(`Could not compose answers: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      onProgress(`Skipping ${fill.unansweredFields.length} open question(s) — agent model not configured.`);
    }
  }

  // Which detected fields are required? Used to flag proposed rows for the UI.
  const requiredSelectors = new Set(inspect.fields.filter((f) => f.required).map((f) => f.selector));

  onProgress("Filling the form (preview only — nothing is submitted)…");
  saveApplyDraft(instructions, [], applyLink);
  const result = await fillAndSubmit(applyLink, instructions, /* dryRun */ true);
  onPreview(await frame("filled", "Form filled — review before submitting", result.screenshotPath));

  // Required fields that fillFields knew were unanswerable, plus any that failed to fill.
  const requiredFailures = (result.failedFields ?? [])
    .filter((f) => fill.unfilledRequired.includes(f.label ?? ""))
    .map((f) => f.label ?? f.selector);
  const unfilledRequired = Array.from(new Set([...fill.unfilledRequired, ...requiredFailures]));

  onProgress(
    `Preview ready: ${result.filledCount ?? instructions.length} field(s) filled` +
      (unfilledRequired.length ? `, ${unfilledRequired.length} required field(s) need your attention.` : "."),
  );

  return {
    applyLink,
    atsHint: inspect.atsHint,
    pageTitle: result.pageTitle,
    filled: instructions.map((i) => ({
      selector: i.selector,
      label: i.label ?? i.selector,
      value: displayValue(i),
      type: i.type ?? "text",
      required: requiredSelectors.has(i.selector),
      // Editable only when Claude wrote it AND it's free text (not a picked option/file).
      editable: composedSelectors.has(i.selector) && (i.type ?? "text") !== "file",
    })),
    unfilledRequired,
    totalFields: inspect.fields.length,
  };
}

// ── Tweak / edit one composed answer ────────────────────────────────────────────
// The preview leaves the form filled but unsubmitted; before approving, the user can
// rewrite an AI-composed answer (Formal / Shorten / Humanize / Informal / Add facts,
// or a freeform instruction). We re-ask Claude for just that field, then patch the
// saved draft so the eventual submit types the revised value. The browser is NOT
// re-filled here — the new text is applied on submit (or the user can re-preview).

const TRANSFORM_DIRECTIVE: Record<string, string> = {
  formal: "Rewrite it in a more formal, professional register. Keep the same facts and meaning.",
  shorten: "Make it noticeably more concise — cut filler, keep the strongest points. Roughly half the length.",
  humanize: "Rewrite it to sound warmer and more human — natural first-person voice, less robotic, no clichés.",
  informal: "Rewrite it in a friendlier, more conversational tone while staying appropriate for a job application.",
  "more-facts":
    "Strengthen it with concrete, specific details drawn ONLY from the applicant's profile (technologies, scope, outcomes). Do not invent facts.",
};

function transformDirective(transform: TweakTransform): string {
  return TRANSFORM_DIRECTIVE[transform] ?? `Apply this instruction to the answer: ${transform}`;
}

/**
 * Rewrite a single AI-composed answer per a tweak transform and patch the saved
 * draft so the next submit uses it. Returns the new value (masked for preview).
 */
export async function tweakAnswer(
  uid: string,
  applyLink: string,
  selector: string,
  transform: TweakTransform,
): Promise<{ value: string }> {
  const current = readDraftInstruction(selector);
  if (!current) throw new Error("That answer is no longer part of the current application draft.");

  const [experience, skills, projects] = await Promise.all([
    readProfileFile("experience", uid),
    readProfileFile("skills", uid),
    readProfileFile("projects", uid),
  ]);

  const client = await getAnthropic();
  const system =
    "You revise a single answer an applicant wrote on a job application. Preserve first-person voice and stay grounded ONLY in the applicant's profile — never fabricate credentials, employers, dates, or metrics. Return ONLY the revised answer text, with no preamble or quotes.";
  const prompt = `Applicant profile (for grounding):
Experience:
${experience || "(not provided)"}

Skills:
${skills || "(not provided)"}

Projects:
${projects || "(not provided)"}

Question: "${current.label ?? selector}"
Current answer:
${current.value}

Revision instruction: ${transformDirective(transform)}

Return the revised answer only.`;

  const resp = await client.messages.create({
    model: agentModel(),
    max_tokens: 2000,
    system,
    messages: [{ role: "user", content: prompt }],
  });
  const text = resp.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!text) throw new Error("The rewrite came back empty — try again.");

  patchDraftInstruction(selector, text);
  return { value: displayValue({ ...current, value: text }) };
}

/** Manually overwrite a draft answer with a user-supplied value (no model call). */
export function editAnswer(selector: string, value: string): { value: string } {
  const current = readDraftInstruction(selector);
  if (!current) throw new Error("That answer is no longer part of the current application draft.");
  patchDraftInstruction(selector, value);
  return { value: displayValue({ ...current, value }) };
}

/** Real submit on the still-open session prepared above; marks the job applied on success. */
export async function submitPreparedApplication(
  uid: string,
  applyLink: string,
  onProgress: ProgressSink = noopProgress,
  onPreview: PreviewSink = noopPreview,
): Promise<SubmitOutcome> {
  onProgress("Submitting application…");
  // Empty instructions → fillAndSubmit reuses the saved draft on the open session,
  // skips already-filled fields, and clicks submit.
  const result = await fillAndSubmit(applyLink, [], /* dryRun */ false);
  onPreview(
    await frame(
      result.success ? "submitted" : "error",
      result.success ? "Application submitted" : "Submit did not confirm — review the screenshot",
      result.screenshotPath,
    ),
  );

  if (result.success) {
    await markApplied([applyLink], uid).catch(() => undefined);
    onProgress("Submitted ✓ — marked as applied in your pipeline.");
  } else {
    onProgress(result.error ? `Not submitted: ${result.error}` : "Submit did not confirm.");
  }

  return { success: result.success, confirmedText: result.confirmedText, error: result.error };
}

/** Abandon a prepared application — closes the browser without submitting. */
export async function discardPreparedApplication(onProgress: ProgressSink = noopProgress): Promise<void> {
  await closeApplySession();
  onProgress("Discarded — the application was not submitted.");
}
