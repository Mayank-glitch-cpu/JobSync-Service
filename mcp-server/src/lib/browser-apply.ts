import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

type BrowserPage = import("playwright").Page;
type BrowserFrame = import("playwright").Frame;
type BrowserLocator = import("playwright").Locator;
type Browser = import("playwright").Browser;
type FormContext = BrowserPage | BrowserFrame;

export interface DetectedField {
  selector: string;
  label: string;
  type: string;
  placeholder: string;
  required: boolean;
  options: string[];
  frameUrl?: string;
  /** True for react-select/ARIA combobox dropdowns (filled by option selection, not a native <select>). */
  combobox?: boolean;
}

export interface InspectResult {
  url: string;
  pageTitle: string;
  atsHint: string;
  fields: DetectedField[];
  screenshotPath: string;
}

export interface FillInstruction {
  selector: string;
  value: string;
  type?: string;
  label?: string;
  frameUrl?: string;
}

export interface PreviewField {
  field: string;
  value: string;
  type?: string;
}

export interface SubmitResult {
  success: boolean;
  screenshotPath: string;
  pageTitle: string;
  confirmedText: string;
  error?: string;
  filledCount?: number;
  failedFields?: Array<{ selector: string; label?: string; error: string }>;
  submitted?: boolean;
  /** Fields the page rejected after a submit attempt — inline validation errors or
   *  required fields left empty/flagged. The agent reads these to know which fields
   *  to fix before reopening the form and submitting again. */
  validationErrors?: Array<{ label: string; selector: string; message: string }>;
  /** The browser session is still open and waiting (e.g. after a recoverable
   *  validation error). The agent can call apply_submit_form again with only the
   *  corrected fields — they fill into the SAME live page, not a fresh reload. */
  sessionOpen?: boolean;
  /** The form is gated behind a verification code emailed to the applicant. The
   *  agent must ask the user for that code and call apply_submit_code with it —
   *  the code is entered in the same live browser session. */
  needsEmailCode?: boolean;
}

export interface FormState {
  url: string;
  originalUrl?: string;
  pageTitle?: string;
  atsHint: string;
  fields: DetectedField[];
  timestamp: number;
  draftInstructions?: FillInstruction[];
  draftPreview?: PreviewField[];
}

const STATE_DIR = join(homedir(), ".jobsync");
const STATE_PATH = join(STATE_DIR, "apply-state.json");
const STATE_TTL_MS = 7_200_000;

export function saveFormState(state: FormState): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
  } catch {
    // State persistence should never fail the apply flow.
  }
}

export function loadFormState(): FormState | null {
  try {
    const raw = readFileSync(STATE_PATH, "utf-8");
    const state = JSON.parse(raw) as FormState;
    if (Date.now() - state.timestamp > STATE_TTL_MS) return null;
    return state;
  } catch {
    return null;
  }
}

export function saveApplyDraft(
  instructions: FillInstruction[],
  preview: PreviewField[] = [],
  applyLink?: string,
): FormState {
  const existing = loadFormState();
  const state: FormState = {
    url: existing?.url ?? applyLink ?? "",
    originalUrl: existing?.originalUrl ?? applyLink,
    pageTitle: existing?.pageTitle,
    atsHint: existing?.atsHint ?? detectAts(applyLink ?? ""),
    fields: existing?.fields ?? [],
    timestamp: Date.now(),
    draftInstructions: instructions,
    draftPreview: preview,
  };
  saveFormState(state);
  return state;
}

function screenshotDir(): string {
  const dir = join(tmpdir(), "jobsync-screenshots");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function screenshotPath(tag: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return join(screenshotDir(), `apply-${tag}-${ts}.png`);
}

export function detectAts(url: string): string {
  if (url.includes("greenhouse.io") || url.includes("grnh.se")) return "greenhouse";
  if (url.includes("lever.co")) return "lever";
  if (url.includes("ashbyhq.com")) return "ashby";
  if (url.includes("myworkdayjobs.com") || url.includes("workday.com")) return "workday";
  if (url.includes("smartrecruiters.com")) return "smartrecruiters";
  if (url.includes("jobvite.com")) return "jobvite";
  return "unknown";
}

export function normalizeFormUrl(applyLink: string, atsHint: string): string {
  if (atsHint === "ashby" && !/\/application\/?$/.test(applyLink)) {
    return applyLink.replace(/\/$/, "") + "/application";
  }
  return applyLink;
}

const APPLY_BUTTON_SELECTORS = [
  'a[href*="/application"]',
  'a[href*="apply"]',
  'button:has-text("Apply for this Job")',
  'button:has-text("Apply for this job")',
  'button:has-text("Apply for this position")',
  'button:has-text("Apply Now")',
  'button:has-text("Apply now")',
  'button:has-text("Apply")',
  'a:has-text("Apply for this Job")',
  'a:has-text("Apply for this job")',
  'a:has-text("Apply Now")',
  'a:has-text("Apply now")',
  'a:has-text("Apply")',
  '[data-testid="apply-button"]',
  '[data-testid*="apply" i]',
  '[aria-label*="apply" i]',
  '[class*="apply-button" i]',
  '.apply-button',
  '[id*="apply-button" i]',
];

const FORM_FIELD_SELECTOR =
  'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="image"]):not([type="reset"]), textarea, select, [role="radio"], [role="checkbox"], [contenteditable="true"]';

const EXTRACT_FIELDS_SCRIPT = `() => {
  function clean(text) {
    return (text || '').replace(/\\s+/g, ' ').replace(/\\*/g, '').trim();
  }

  function short(text, max) {
    const value = clean(text);
    return value.length > max ? value.slice(0, max).trim() : value;
  }

  function labelFromRelatedElement(el) {
    const ariaLabel = clean(el.getAttribute('aria-label'));
    if (ariaLabel) return ariaLabel;

    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .split(/\\s+/)
        .map((id) => document.getElementById(id)?.innerText || '')
        .join(' ');
      if (clean(text)) return short(text, 180);
    }

    if (el.id) {
      const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (label) return short(label.innerText, 180);
    }

    let parent = el.parentElement;
    for (let i = 0; i < 6 && parent; i++) {
      if (parent.tagName === 'LABEL') return short(parent.innerText, 180);
      const legend = parent.querySelector(':scope > legend');
      if (legend && clean(legend.innerText)) return short(legend.innerText, 180);
      const directLabel = parent.querySelector(':scope > label');
      if (directLabel && clean(directLabel.innerText)) return short(directLabel.innerText, 180);
      parent = parent.parentElement;
    }

    const describedBy = el.getAttribute('aria-describedby');
    if (describedBy) {
      const text = describedBy
        .split(/\\s+/)
        .map((id) => document.getElementById(id)?.innerText || '')
        .join(' ');
      if (clean(text)) return short(text, 180);
    }

    let sibling = el.previousElementSibling;
    for (let i = 0; i < 4 && sibling; i++) {
      if (clean(sibling.innerText) && clean(sibling.innerText).length < 180) {
        return short(sibling.innerText, 180);
      }
      sibling = sibling.previousElementSibling;
    }

    return clean(el.placeholder || el.name || el.id || el.getAttribute('data-testid') || '');
  }

  function uniqueSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    if (el.name) return el.tagName.toLowerCase() + '[name="' + CSS.escape(el.name) + '"]';
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
    if (testId) return '[data-testid="' + CSS.escape(testId) + '"]';

    const parts = [];
    let cur = el;
    for (let i = 0; i < 6 && cur && cur !== document.body; i++) {
      const parent = cur.parentElement;
      if (!parent) break;
      const siblings = Array.from(parent.children).filter((child) => child.tagName === cur.tagName);
      const index = siblings.indexOf(cur);
      parts.unshift(cur.tagName.toLowerCase() + (siblings.length > 1 ? ':nth-of-type(' + (index + 1) + ')' : ''));
      cur = parent;
    }
    return parts.join(' > ');
  }

  function requiredFromContext(el) {
    if (el.required || el.getAttribute('aria-required') === 'true') return true;
    let parent = el.parentElement;
    for (let i = 0; i < 4 && parent; i++) {
      const text = parent.innerText || '';
      if (/\\*|required/i.test(text) && text.length < 500) return true;
      parent = parent.parentElement;
    }
    return false;
  }

  function radioOptions(el) {
    const name = el.getAttribute('name');
    const selector = name
      ? 'input[type="radio"][name="' + CSS.escape(name) + '"]'
      : 'input[type="radio"]';
    return Array.from(document.querySelectorAll(selector))
      .map((radio) => labelFromRelatedElement(radio) || radio.value)
      .map(clean)
      .filter(Boolean);
  }

  // For a radio/checkbox, labelFromRelatedElement returns the per-option label
  // (e.g. "Yes"). The actual question lives on the enclosing fieldset/group, so
  // climb to it and strip the option labels to recover the question text.
  function groupQuestionLabel(el) {
    const fieldset = el.closest('fieldset, [role="radiogroup"], [role="group"]');
    if (fieldset) {
      const legend = fieldset.querySelector(':scope > legend');
      if (legend && clean(legend.innerText)) return short(legend.innerText, 180);
      let text = clean(fieldset.innerText);
      for (const option of radioOptions(el)) {
        text = text.split(option).join(' ');
      }
      text = clean(text);
      if (text) return short(text, 180);
    }
    return labelFromRelatedElement(el);
  }

  function selectOptions(el) {
    return Array.from(el.options || [])
      .map((option) => clean(option.text || option.label || option.value))
      .filter(Boolean);
  }

  const elements = Array.from(document.querySelectorAll('input, textarea, select, [role="radio"], [role="checkbox"], [contenteditable="true"]'));
  const seen = new Set();
  const fields = [];

  for (const el of elements) {
    const tag = el.tagName;
    const role = (el.getAttribute('role') || '').toLowerCase();
    const inputType = tag === 'INPUT' ? (el.type || 'text').toLowerCase() : '';
    // A react-select / custom dropdown is an <input role="combobox"> backed by a
    // popup option list (aria-haspopup / aria-autocomplete=list) instead of a
    // native <select>. Treat it as a select so it is filled by option-selection.
    const isComboboxDropdown =
      tag === 'INPUT' &&
      role === 'combobox' &&
      (el.getAttribute('aria-haspopup') === 'true' ||
        /list|listbox|both/.test(el.getAttribute('aria-autocomplete') || ''));
    const type = tag === 'SELECT' ? 'select'
      : isComboboxDropdown ? 'select'
      : tag === 'TEXTAREA' || el.getAttribute('contenteditable') === 'true' ? 'textarea'
      : role === 'radio' ? 'radio'
      : role === 'checkbox' ? 'checkbox'
      : inputType || 'text';

    if (['hidden', 'submit', 'button', 'image', 'reset'].includes(type)) continue;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;

    // Never surface bot-challenge fields (reCAPTCHA/hCaptcha) — they are not
    // user-answerable and must not become fill instructions.
    const identity = ((el.name || '') + ' ' + (el.id || '') + ' ' + (el.className || '')).toLowerCase();
    if (/recaptcha|captcha|hcaptcha|turnstile/.test(identity)) continue;

    // Skip the internal search/country inputs of the intl-tel-input phone widget
    // (id like "iti-0__search-input", wrapper class "iti"). The real phone <input>
    // lives outside that wrapper and is captured separately.
    if (/^iti-/.test(el.id || '') || el.closest('.iti, .intl-tel-input')) continue;

    const selector = uniqueSelector(el);
    const groupKey = type === 'radio' && el.name ? 'radio:' + el.name : selector;
    if (seen.has(groupKey)) continue;
    seen.add(groupKey);

    const options = type === 'select' && tag === 'SELECT' ? selectOptions(el) : type === 'radio' ? radioOptions(el) : [];

    // Skip the phone widget's country selector: its options are a country list
    // carrying dial codes ("United States +1", "India +91"). It is not a question
    // the applicant answers — the phone <input> already encodes the country.
    // NOTE: double-escape regex backslashes — this runs inside a template-literal
    // string injected into the page (single \\ would be stripped before reaching the browser).
    if (options.length > 5 && options.filter((o) => /\\+\\d{1,4}\\s*$/.test(o)).length > options.length / 2) continue;

    fields.push({
      selector,
      label: type === 'radio' || type === 'checkbox' ? groupQuestionLabel(el) : labelFromRelatedElement(el),
      type,
      placeholder: clean(el.placeholder || ''),
      required: requiredFromContext(el),
      options,
      ...(isComboboxDropdown ? { combobox: true } : {}),
    });
  }

  return fields;
}`;

// ─── Human-like interaction helpers ─────────────────────────────────────────
// Anti-bot systems (Greenhouse/Ashby fraud scoring, Cloudflare, reCAPTCHA v3)
// flag applications that fill instantly, never move the mouse, paste full values
// into inputs, and submit in a few hundred milliseconds. These helpers add the
// jitter, mouse travel, keystroke cadence, and idle scrolling a real applicant
// produces so a genuine application is not silently scored as spam/bot traffic.

/** Inclusive random integer in [min, max]. */
function rand(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

/** Sleep a randomised amount — never the same fixed delay twice. */
async function humanPause(page: BrowserPage, min: number, max: number): Promise<void> {
  await page.waitForTimeout(rand(min, max)).catch(() => undefined);
}

/** Glide the cursor to a point inside the element (not always dead-centre) with
 *  multi-step movement, the way a real pointer travels — never a teleport. */
async function moveMouseToLocator(page: BrowserPage, locator: BrowserLocator): Promise<void> {
  const box = await locator.boundingBox().catch(() => null);
  if (!box) return;
  const x = box.x + box.width * (0.25 + Math.random() * 0.5);
  const y = box.y + box.height * (0.25 + Math.random() * 0.5);
  await page.mouse.move(x, y, { steps: rand(8, 22) }).catch(() => undefined);
  await humanPause(page, 40, 160);
}

/** A few short scroll bursts (occasionally upward) to mimic a person reading the
 *  form between fields, rather than the page staying perfectly still. */
async function humanScroll(page: BrowserPage): Promise<void> {
  const bursts = rand(1, 3);
  for (let i = 0; i < bursts; i++) {
    const up = Math.random() < 0.15;
    await page.mouse.wheel(0, (up ? -1 : 1) * rand(120, 460)).catch(() => undefined);
    await humanPause(page, 150, 520);
  }
}

/** Type one character at a time with per-keystroke jitter and the occasional
 *  longer "thinking" pause. Assumes the target element is already focused. */
async function typeWithJitter(page: BrowserPage, text: string): Promise<void> {
  for (const ch of text) {
    await page.keyboard.type(ch).catch(() => undefined);
    await humanPause(page, 45, 140);
    if (Math.random() < 0.07) await humanPause(page, 180, 460);
  }
}

/** Fill a text input the way a person would: move the cursor over, click to
 *  focus, clear any prefill, then type with jitter. Falls back to a plain fill
 *  if keystroke typing left the field empty (e.g. masked/controlled inputs). */
async function humanType(page: BrowserPage, locator: BrowserLocator, value: string): Promise<void> {
  await moveMouseToLocator(page, locator);
  await locator.click({ timeout: 5000 }).catch(() => locator.focus().catch(() => undefined));
  await humanPause(page, 60, 200);
  await locator.fill("").catch(async () => {
    await locator.press("ControlOrMeta+a").catch(() => undefined);
    await locator.press("Delete").catch(() => undefined);
  });
  await typeWithJitter(page, value);

  const current = (await locator.inputValue().catch(() => "")) || "";
  if (value.trim() && current.trim() === "") {
    await locator.fill(value).catch(() => undefined);
  }
}

async function scrollPageToLoad(page: BrowserPage): Promise<void> {
  await page
    .evaluate(`(async () => {
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const max = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      const step = Math.max(Math.floor(window.innerHeight * 0.8), 500);
      for (let y = 0; y <= max + step; y += step) {
        window.scrollTo(0, y);
        await delay(180);
      }
      window.scrollTo(0, 0);
    })()`)
    .catch(() => undefined);
  await page.waitForTimeout(300);
}

function contextUrl(ctx: FormContext): string {
  return ctx.url();
}

function allContexts(page: BrowserPage): FormContext[] {
  return [page, ...page.frames().filter((frame) => frame !== page.mainFrame())];
}

async function extractFieldsFromContext(ctx: FormContext, frameUrl?: string): Promise<DetectedField[]> {
  try {
    // Playwright's evaluate(string) treats a bare `() => {…}` literal as an
    // expression that yields a function but never calls it (→ undefined). Wrap
    // it as a self-invoking expression `(…)()` so the script actually runs.
    const fields = (await ctx.evaluate(`(${EXTRACT_FIELDS_SCRIPT})()`)) as DetectedField[];
    return Array.isArray(fields)
      ? fields.map((field) => ({ ...field, ...(frameUrl ? { frameUrl } : {}) }))
      : [];
  } catch {
    return [];
  }
}

async function extractAllFields(page: BrowserPage): Promise<DetectedField[]> {
  const fields: DetectedField[] = [];

  fields.push(...(await extractFieldsFromContext(page)));

  for (const frame of page.frames().filter((f) => f !== page.mainFrame())) {
    const frameFields = await extractFieldsFromContext(frame, frame.url());
    fields.push(...frameFields);
  }

  const seen = new Set<string>();
  const deduped = fields.filter((field) => {
    const key = `${field.frameUrl ?? "main"}|${field.selector}|${field.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Collapse duplicate single-value fields that share a question label (Greenhouse
  // react-select renders a hidden value input alongside the visible combobox, so the
  // same question surfaces twice — once with an `#id` selector and once positional).
  // Prefer the entry whose selector is id-based. Never dedup radio/checkbox: those
  // are option groups where many inputs legitimately share the group label.
  const SINGLE_VALUE = new Set(["text", "email", "tel", "select", "textarea", "search", "url", "number", "date"]);
  const byLabel = new Map<string, DetectedField>();
  const result: DetectedField[] = [];
  for (const field of deduped) {
    const normLabel = field.label.replace(/\s+/g, " ").trim().toLowerCase();
    if (!normLabel || field.type === "radio" || field.type === "checkbox" || !SINGLE_VALUE.has(field.type)) {
      result.push(field);
      continue;
    }
    const key = `${field.frameUrl ?? "main"}|${normLabel}`;
    const existing = byLabel.get(key);
    if (!existing) {
      byLabel.set(key, field);
      result.push(field);
      continue;
    }
    // Keep whichever has the stronger (id-based) selector; merge combobox/options.
    const existingHasId = existing.selector.startsWith("#");
    const fieldHasId = field.selector.startsWith("#");
    if (fieldHasId && !existingHasId) {
      existing.selector = field.selector;
    }
    existing.combobox = existing.combobox || field.combobox;
    if (!existing.options.length && field.options.length) existing.options = field.options;
    existing.required = existing.required || field.required;
  }
  return result;
}

export function looksLikeApplicationForm(fields: DetectedField[]): boolean {
  if (fields.length >= 5) return true;
  const text = fields
    .map((field) => `${field.label} ${field.placeholder} ${field.selector} ${field.type}`)
    .join(" ")
    .toLowerCase();
  const signals = [
    /first\s+name|given\s+name/.test(text),
    /last\s+name|surname|family\s+name/.test(text),
    /email/.test(text),
    /phone|mobile|telephone/.test(text),
    /resume|cv|curriculum/.test(text),
    /linkedin|github|portfolio/.test(text),
  ];
  return signals.filter(Boolean).length >= 2;
}

async function waitForFormFields(page: BrowserPage, timeoutMs = 12_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    for (const ctx of allContexts(page)) {
      try {
        if ((await ctx.locator(FORM_FIELD_SELECTOR).count()) > 0) return;
      } catch {
        // Keep polling; frames can detach while the app is rendering.
      }
    }
    await page.waitForTimeout(350);
  }
}

async function clickAndFollow(page: BrowserPage, locator: BrowserLocator): Promise<BrowserPage> {
  const context = page.context();
  const newPagePromise = context.waitForEvent("page", { timeout: 5000 }).catch(() => null);
  const navPromise = page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => undefined);

  await locator.scrollIntoViewIfNeeded().catch(() => undefined);
  await locator.click({ timeout: 8000 });

  const newPage = await newPagePromise;
  if (newPage) {
    await newPage.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
    return newPage;
  }

  await navPromise;
  return page;
}

async function clickApplyButtonIfPresent(page: BrowserPage): Promise<{ clicked: boolean; page: BrowserPage }> {
  await scrollPageToLoad(page);

  for (const selector of APPLY_BUTTON_SELECTORS) {
    try {
      const locator = page.locator(selector).first();
      if ((await locator.count()) > 0 && (await locator.isVisible({ timeout: 1000 }).catch(() => false))) {
        return { clicked: true, page: await clickAndFollow(page, locator) };
      }
    } catch {
      // Try the next selector.
    }
  }

  for (const locator of [
    page.getByRole("link", { name: /apply/i }).first(),
    page.getByRole("button", { name: /apply/i }).first(),
  ]) {
    try {
      if ((await locator.count()) > 0 && (await locator.isVisible({ timeout: 1000 }).catch(() => false))) {
        return { clicked: true, page: await clickAndFollow(page, locator) };
      }
    } catch {
      // Try the next locator.
    }
  }

  return { clicked: false, page };
}

async function openApplicationForm(page: BrowserPage, applyLink: string): Promise<{ page: BrowserPage; atsHint: string }> {
  const atsHint = detectAts(applyLink);
  await page.goto(normalizeFormUrl(applyLink, atsHint), {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });

  await waitForFormFields(page, 5000).catch(() => undefined);
  await scrollPageToLoad(page);

  let fields = await extractAllFields(page);
  if (!looksLikeApplicationForm(fields)) {
    const clickResult = await clickApplyButtonIfPresent(page);
    page = clickResult.page;
    if (clickResult.clicked) {
      await waitForFormFields(page, 12_000).catch(() => undefined);
      await scrollPageToLoad(page);
    }
  }

  return { page, atsHint };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function locatorUsable(locator: BrowserLocator, allowHidden = false): Promise<boolean> {
  try {
    if ((await locator.count()) === 0) return false;
    if (allowHidden) return true;
    return await locator.isVisible({ timeout: 500 }).catch(() => false);
  } catch {
    return false;
  }
}

function orderedContexts(page: BrowserPage, frameUrl?: string): FormContext[] {
  const contexts = allContexts(page);
  if (frameUrl) {
    return [
      ...contexts.filter((ctx) => contextUrl(ctx) === frameUrl),
      ...contexts.filter((ctx) => contextUrl(ctx) !== frameUrl),
    ];
  }
  // Prioritise known ATS form frames so field lookups hit the right frame first.
  const formFrames = contexts.filter(
    (ctx) =>
      contextUrl(ctx).includes("boards.greenhouse.io") ||
      contextUrl(ctx).includes("app.greenhouse.io") ||
      /\/application(\/|\?|#|$)/.test(contextUrl(ctx)),
  );
  return [...formFrames, ...contexts.filter((c) => !formFrames.includes(c))];
}

async function findInstructionLocator(page: BrowserPage, instr: FillInstruction): Promise<BrowserLocator | null> {
  const allowHidden = instr.type === "file";
  const label = instr.label || instr.selector;
  const contexts = orderedContexts(page, instr.frameUrl);

  for (const ctx of contexts) {
    try {
      const locator = ctx.locator(instr.selector).first();
      if (await locatorUsable(locator, allowHidden)) return locator;
    } catch {
      // The selector may be a human label rather than CSS.
    }
  }

  if (instr.type === "file") {
    for (const ctx of contexts) {
      const locator = ctx.locator('input[type="file"]').first();
      if (await locatorUsable(locator, true)) return locator;
    }
  }

  for (const ctx of contexts) {
    for (const locator of [
      ctx.getByLabel(label, { exact: false }).first(),
      ctx.getByPlaceholder(label, { exact: false }).first(),
      ctx.getByRole("textbox", { name: new RegExp(escapeRegExp(label), "i") }).first(),
      ctx.getByRole("combobox", { name: new RegExp(escapeRegExp(label), "i") }).first(),
    ]) {
      if (await locatorUsable(locator, allowHidden)) return locator;
    }
  }

  return null;
}

async function labelForInput(ctx: FormContext, input: BrowserLocator): Promise<string> {
  const label = await input
    .evaluate((el: any) => {
      const clean = (value: string | null | undefined) => (value || "").replace(/\s+/g, " ").trim();
      const id = el.getAttribute("id");
      if (id) {
        const label = (globalThis as any).document.querySelector(`label[for="${(globalThis as any).CSS.escape(id)}"]`);
        if (label?.textContent) return clean(label.textContent);
      }
      let parent = el.parentElement;
      for (let i = 0; i < 5 && parent; i++) {
        if (parent.tagName === "LABEL") return clean(parent.textContent);
        parent = parent.parentElement;
      }
      return clean(el.getAttribute("aria-label") || el.value);
    })
    .catch(async () => {
      const id = await input.getAttribute("id").catch(() => null);
      if (!id) return "";
      return ctx.locator(`label[for="${id}"]`).first().textContent().catch(() => "");
    });
  return label ?? "";
}

async function checkOptionInGroup(
  ctx: FormContext,
  group: BrowserLocator,
  instr: FillInstruction,
  choiceType: "radio" | "checkbox",
): Promise<boolean> {
  const needle = instr.value.toLowerCase();
  const byRole = group
    .getByRole(choiceType, { name: new RegExp(`^\\s*${escapeRegExp(instr.value)}\\s*$`, "i") })
    .first();
  if (await locatorUsable(byRole)) {
    await byRole.check().catch(() => byRole.click());
    return true;
  }
  const choices = await group.locator(`input[type="${choiceType}"]`).all().catch(() => []);
  for (const choice of choices) {
    const text = `${await labelForInput(ctx, choice)} ${await choice.getAttribute("value").catch(() => "")}`.toLowerCase();
    if (text.includes(needle)) {
      await choice.check().catch(() => choice.click());
      return true;
    }
  }
  return false;
}

async function clickChoice(page: BrowserPage, instr: FillInstruction, choiceType: "radio" | "checkbox"): Promise<void> {
  const needle = instr.value.toLowerCase();
  const contexts = orderedContexts(page, instr.frameUrl);

  // Strategy 1 (primary): locate the group by its QUESTION LABEL, then pick the
  // option within. This is essential because some ATSes (Ashby) randomize element
  // IDs on every page load, so the selector captured at inspect time is stale at
  // fill time — and a page often has several Yes/No groups (work-authorization +
  // sponsorship). Scoping by the question text fills the right group every time.
  const label = (instr.label || "").replace(/\s+/g, " ").trim();
  if (label) {
    const probe = label.slice(0, 60);
    for (const ctx of contexts) {
      const groups = ctx
        .locator('fieldset, [role="radiogroup"], [role="group"]')
        .filter({ hasText: probe });
      const count = await groups.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        if (await checkOptionInGroup(ctx, groups.nth(i), instr, choiceType)) return;
      }
    }
  }

  // Strategy 2: resolve the group via the instruction's selector → shared `name`
  // (works when IDs are stable, e.g. Greenhouse/Lever).
  const groupLocator = await findInstructionLocator(page, instr);
  const groupName = await groupLocator?.getAttribute("name").catch(() => null);
  if (groupName) {
    for (const ctx of contexts) {
      const choices = await ctx.locator(`input[type="${choiceType}"][name="${groupName}"]`).all().catch(() => []);
      for (const choice of choices) {
        const text = `${await labelForInput(ctx, choice)} ${await choice.getAttribute("value").catch(() => "")}`.toLowerCase();
        if (text.includes(needle)) {
          await choice.check().catch(() => choice.click());
          return;
        }
      }
    }
  }

  // Strategy 3 (last resort): global option match. Only reached when neither the
  // label nor the selector could resolve a group.
  for (const ctx of contexts) {
    const choices = await ctx.locator(`input[type="${choiceType}"]`).all().catch(() => []);
    for (const choice of choices) {
      const text = `${await labelForInput(ctx, choice)} ${await choice.getAttribute("value").catch(() => "")}`.toLowerCase();
      if (text.includes(needle)) {
        await choice.check().catch(() => choice.click());
        return;
      }
    }
  }

  throw new Error(`Could not find ${choiceType} option matching "${instr.value}".`);
}

async function selectBestOption(locator: BrowserLocator, value: string): Promise<void> {
  // If the dropdown offers exactly one real choice, select it outright — don't try
  // to reason a value against a single option.
  const lone = await locator
    .evaluate((el: any) => {
      const opts = Array.from(el.options || []).filter(
        (o: any) => o.value !== "" && !o.disabled && !/select|choose|^\s*$/i.test(o.text || ""),
      ) as Array<{ value: string }>;
      return opts.length === 1 ? opts[0]!.value : null;
    })
    .catch(() => null);
  if (lone !== null) {
    await locator.selectOption({ value: lone }).catch(() => undefined);
    return;
  }

  await locator.selectOption({ label: value }).catch(async () => {
    await locator.selectOption({ value }).catch(async () => {
      const match = await locator.evaluate((el: any, wanted) => {
        const needle = String(wanted).toLowerCase();
        const options = Array.from(el.options || []) as Array<{ text: string; label: string; value: string }>;
        const option = options.find((item) => {
          const text = `${item.text} ${item.label} ${item.value}`.toLowerCase();
          return text.includes(needle);
        });
        return option?.value ?? null;
      }, value);
      if (!match) throw new Error(`No select option matched "${value}".`);
      await locator.selectOption({ value: match });
    });
  });
}

function checkboxTarget(value: string): boolean {
  return /^(true|yes|y|1|checked)$/i.test(value.trim());
}

async function verifyFilled(locator: BrowserLocator, instr: FillInstruction): Promise<boolean> {
  try {
    switch (instr.type ?? "text") {
      case "file":
        return (await locator.evaluate((el: any) => el.files?.length ?? 0)) > 0;
      case "checkbox":
      case "radio":
        return await locator.isChecked().catch(() => true);
      case "select":
        return Boolean(await locator.inputValue().catch(() => "selected"));
      default: {
        const current = await locator.inputValue().catch(() => "");
        return current.trim().length > 0;
      }
    }
  } catch {
    return true;
  }
}

// Some text fields are typeahead comboboxes (e.g. Ashby's Location/Google-Places
// autocomplete): typing alone leaves the value unconfirmed — a suggestion must be
// selected. Type the value, then click the first listbox option. If the full value
// yields no suggestions, retry with the first comma-segment (e.g. just the city).
async function fillCombobox(page: BrowserPage, locator: BrowserLocator, instr: FillInstruction): Promise<void> {
  const contexts = orderedContexts(page, instr.frameUrl);
  const want = instr.value.replace(/\s+/g, " ").trim().toLowerCase();

  // Resolve the option list THIS combobox controls (via aria-controls/aria-owns),
  // falling back to the single open listbox so we never grab an unrelated popup.
  const optionsLocator = async (ctx: FormContext): Promise<BrowserLocator | null> => {
    const listboxId =
      (await locator.getAttribute("aria-controls").catch(() => null)) ||
      (await locator.getAttribute("aria-owns").catch(() => null));
    if (listboxId) return ctx.locator(`[id="${listboxId}"] [role="option"]`);
    const listboxes = ctx.locator('[role="listbox"]');
    return (await listboxes.count().catch(() => 0)) === 1
      ? listboxes.first().locator('[role="option"]')
      : null;
  };

  // Single-option shortcut: open the dropdown and, if it offers exactly one choice,
  // click it directly instead of typing the whole value out.
  await moveMouseToLocator(page, locator);
  await locator.click().catch(() => undefined);
  await page.waitForTimeout(rand(300, 550));
  for (const ctx of contexts) {
    const opts = await optionsLocator(ctx);
    if (!opts) continue;
    const n = await opts.count().catch(() => 0);
    if (n === 1) {
      await opts.first().click().catch(() => undefined);
      return;
    }
    if (n > 0) {
      // Several options — close the probe menu so the typing path starts clean.
      await locator.press("Escape").catch(() => undefined);
      break;
    }
  }

  const openAndType = async (text: string): Promise<void> => {
    await moveMouseToLocator(page, locator);
    await locator.click().catch(() => undefined);
    // Clear any existing text, then type so the option list filters down.
    await locator.fill("").catch(async () => {
      await locator.press("ControlOrMeta+a").catch(() => undefined);
      await locator.press("Delete").catch(() => undefined);
    });
    // Type with human jitter so the typeahead filters as a person would trigger
    // it; fall back to an instant fill if keystrokes did not register.
    await typeWithJitter(page, text);
    if (((await locator.inputValue().catch(() => "")) || "").trim() === "" && text.trim()) {
      await locator.fill(text).catch(() => undefined);
    }
    await page.waitForTimeout(rand(550, 850));
  };

  // Click the option that best matches the wanted value. Reason over the rendered
  // suggestions in stages instead of demanding a full-string match: exact text →
  // substring either direction → highest token overlap (so typing "San Francisco,
  // California, United States" still picks the "San Francisco, CA" suggestion).
  const wantTokens = new Set(want.replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean));
  const clickBestOption = async (): Promise<boolean> => {
    for (const ctx of contexts) {
      const options = ctx.locator('[role="option"]');
      const n = await options.count().catch(() => 0);
      if (!n) continue;
      const texts: string[] = [];
      for (let i = 0; i < n; i++) {
        texts.push((await options.nth(i).innerText().catch(() => "")).replace(/\s+/g, " ").trim().toLowerCase());
      }
      let idx = texts.findIndex((t) => t === want);
      if (idx < 0) idx = texts.findIndex((t) => t && (t.includes(want) || want.includes(t)));
      if (idx < 0 && wantTokens.size) {
        // Token-overlap fallback: score each option by how many words it shares
        // with the wanted value and take the best (must share at least one).
        let bestIdx = -1;
        let bestShared = 0;
        texts.forEach((t, i) => {
          if (!t) return;
          const tokens = t.replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
          const shared = tokens.filter((tok) => wantTokens.has(tok)).length;
          if (shared > bestShared) {
            bestShared = shared;
            bestIdx = i;
          }
        });
        idx = bestIdx;
      }
      if (idx >= 0) {
        await options.nth(idx).click().catch(() => undefined);
        return true;
      }
    }
    return false;
  };

  const committed = async (): Promise<boolean> => {
    const current = (await locator.inputValue().catch(() => "")) || "";
    // react-select clears the typed text into a separate display; treat a matching
    // or emptied input (option chosen, search box reset) as success.
    return current.trim() === "" || current.replace(/\s+/g, " ").trim().toLowerCase() === want;
  };

  for (const text of [instr.value, instr.value.split(",")[0]?.trim()].filter(Boolean) as string[]) {
    await openAndType(text);
    if (await clickBestOption()) return;
    // Keyboard fallback: commit the highlighted top match (does not submit the form).
    await locator.press("Enter").catch(() => undefined);
    await page.waitForTimeout(150);
    if (await committed()) return;
  }
  // Last resort: leave the typed value as free text.
  await locator.fill(instr.value).catch(() => undefined);
}

async function isComboboxLocator(locator: BrowserLocator): Promise<boolean> {
  const role = (await locator.getAttribute("role").catch(() => null)) ?? "";
  const autoc = (await locator.getAttribute("aria-autocomplete").catch(() => null)) ?? "";
  return role === "combobox" || autoc === "list" || autoc === "listbox" || autoc === "both";
}

async function fillOneField(page: BrowserPage, instr: FillInstruction): Promise<void> {
  const type = instr.type ?? "text";
  const locator = await findInstructionLocator(page, instr);

  if (!locator && type !== "radio" && type !== "checkbox") {
    throw new Error("Could not locate field.");
  }

  switch (type) {
    case "file": {
      // Try resume-specific selectors first, then fall back to the located input.
      const RESUME_SELECTORS = [
        'input[type="file"][name*="resume" i]',
        'input[type="file"][accept*="pdf"]',
        'input[type="file"]',
      ];
      let fileLocator = locator;
      if (!fileLocator) {
        const contexts = orderedContexts(page, instr.frameUrl);
        for (const sel of RESUME_SELECTORS) {
          for (const ctx of contexts) {
            const candidate = ctx.locator(sel).first();
            if (await locatorUsable(candidate, true)) {
              fileLocator = candidate;
              break;
            }
          }
          if (fileLocator) break;
        }
      }
      if (!fileLocator) throw new Error("Could not locate file input for resume upload.");
      await fileLocator.setInputFiles(instr.value);
      // Poll for the ATS to register the file rather than blocking a fixed second.
      const uploadDeadline = Date.now() + 2000;
      let uploadConfirmed = false;
      while (Date.now() < uploadDeadline) {
        uploadConfirmed = await fileLocator
          .evaluate((el: any) => (el.files?.length ?? 0) > 0)
          .catch(() => false);
        if (uploadConfirmed) break;
        await page.waitForTimeout(100);
      }
      if (!uploadConfirmed) {
        console.warn("[apply] resume upload could not be confirmed — files.length is 0 after 2 s");
      }
      return;
    }

    case "select":
      // react-select/ARIA comboboxes are <input>s, not native <select>s — they
      // have no selectOption support, so drive them as a typeahead instead.
      // fillCombobox self-verifies; its input goes empty after selection, so skip
      // the generic inputValue check below by returning early.
      if (await isComboboxLocator(locator!)) {
        await fillCombobox(page, locator!, instr);
        return;
      }
      await selectBestOption(locator!, instr.value);
      break;

    case "radio":
      await clickChoice(page, instr, "radio");
      return;

    case "checkbox": {
      const boolLike = /^(true|false|yes|no|y|n|1|0|checked|unchecked)$/i.test(instr.value.trim());
      if (!boolLike) {
        await clickChoice(page, instr, "checkbox");
        return;
      }
      const checked = await locator!.isChecked().catch(() => false);
      const target = checkboxTarget(instr.value);
      if (checked !== target) await locator!.click();
      break;
    }

    default:
      await locator!.scrollIntoViewIfNeeded().catch(() => undefined);
      if (await isComboboxLocator(locator!)) {
        await fillCombobox(page, locator!, instr);
        return;
      }
      await humanType(page, locator!, instr.value);
  }

  if (locator && !(await verifyFilled(locator, instr))) {
    throw new Error("Field did not retain the filled value.");
  }
}

async function clickSubmit(page: BrowserPage): Promise<boolean> {
  const textCandidates = [
    /submit application/i,
    /^submit$/i,
    /send application/i,
    /^apply$/i,
    /complete application/i,
  ];

  // A short hesitation before committing, then a real cursor move to the button —
  // a person does not submit a multi-field form in the same instant they finish typing.
  await humanPause(page, 500, 1200);

  for (const ctx of allContexts(page)) {
    for (const selector of ['button[type="submit"]', 'input[type="submit"]']) {
      const locator = ctx.locator(selector).first();
      if (await locatorUsable(locator)) {
        await locator.scrollIntoViewIfNeeded().catch(() => undefined);
        await moveMouseToLocator(page, locator);
        await locator.click();
        return true;
      }
    }

    for (const name of textCandidates) {
      for (const locator of [
        ctx.getByRole("button", { name }).first(),
        ctx.getByRole("link", { name }).first(),
      ]) {
        if (await locatorUsable(locator)) {
          await locator.scrollIntoViewIfNeeded().catch(() => undefined);
          await moveMouseToLocator(page, locator);
          await locator.click();
          return true;
        }
      }
    }
  }

  return false;
}

async function allBodyText(page: BrowserPage): Promise<string> {
  const parts: string[] = [];
  for (const ctx of allContexts(page)) {
    const text = await ctx.evaluate("document.body ? document.body.innerText : ''").catch(() => "");
    if (text) parts.push(String(text));
  }
  return parts.join("\n");
}

// After a submit attempt that did NOT confirm, work out WHY the form bounced:
// read the inline validation messages the ATS rendered, plus any required field
// still empty or flagged aria-invalid. This is the signal the agent uses to reason
// about which field it missed (commonly phone or a dropdown that never committed)
// and to recompose just those values before reopening the form to submit again.
async function detectValidationErrors(
  page: BrowserPage,
): Promise<Array<{ label: string; selector: string; message: string }>> {
  const results: Array<{ label: string; selector: string; message: string }> = [];

  for (const ctx of allContexts(page)) {
    const found = await ctx
      .evaluate(`(() => {
        const clean = (t) => (t || '').replace(/\\s+/g, ' ').trim();
        const out = [];

        // 1. Explicit inline error / alert messages rendered next to a field.
        const errorNodes = Array.from(document.querySelectorAll(
          '[role="alert"], [aria-live="assertive"], .error, .error-message, [class*="error" i], [class*="invalid" i], [data-testid*="error" i]'
        ));
        for (const node of errorNodes) {
          if (node.offsetParent === null) continue; // skip hidden nodes
          const msg = clean(node.innerText || node.textContent);
          if (msg && msg.length < 200 && /required|invalid|must|please|enter|select|valid|empty|missing|provide/i.test(msg)) {
            out.push({ label: msg, selector: '', message: msg });
          }
        }

        // 2. Required fields still empty or explicitly flagged invalid.
        const fields = Array.from(document.querySelectorAll(
          'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]), textarea, select'
        ));
        for (const el of fields) {
          const invalid = el.getAttribute('aria-invalid') === 'true';
          const required = el.required || el.getAttribute('aria-required') === 'true';
          const value = el.value;
          const empty = !(value && String(value).trim());
          if (!invalid && !(required && empty)) continue;

          const id = el.getAttribute('id');
          let labelText = '';
          if (id) {
            const lbl = document.querySelector('label[for="' + CSS.escape(id) + '"]');
            if (lbl) labelText = clean(lbl.innerText || lbl.textContent);
          }
          if (!labelText) labelText = clean(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '');
          const selector = id ? '#' + id
            : el.getAttribute('name') ? el.tagName.toLowerCase() + '[name="' + el.getAttribute('name') + '"]'
            : '';
          out.push({
            label: labelText || '(unlabeled field)',
            selector,
            message: invalid ? 'flagged invalid by the form' : 'required but empty',
          });
        }
        return out;
      })()`)
      .catch(() => []);
    if (Array.isArray(found)) {
      results.push(...(found as Array<{ label: string; selector: string; message: string }>));
    }
  }

  const seen = new Set<string>();
  return results
    .filter((r) => {
      const key = `${r.label}|${r.selector}|${r.message}`.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 30);
}

async function newBrowserPage(applyLink: string): Promise<{ browser: import("playwright").Browser; page: BrowserPage; atsHint: string }> {
  let playwright;
  try {
    playwright = await import("playwright");
  } catch {
    throw new Error(
      "Playwright is not installed. Run: npm i -g jobsync-mcp@latest && npx playwright install chromium",
    );
  }

  const browser = await playwright.chromium.launch({
    headless: process.env.JOBSYNC_HEADLESS === "true" || process.env.NODE_ENV === "production",
    // Strip the headless/automation banner and the navigator.webdriver flag that
    // fraud scoring keys on. --disable-blink-features=AutomationControlled is the
    // single most effective tell to suppress.
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-default-browser-check",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  });
  const ctx = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 768 },
    locale: "en-US",
  });
  // Belt-and-suspenders: blank out navigator.webdriver before any page script runs,
  // in case the launch flag is not honoured by the installed Chromium build.
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  const startPage = await ctx.newPage();
  const opened = await openApplicationForm(startPage, applyLink);
  return { browser, page: opened.page, atsHint: opened.atsHint };
}

// Open each detected combobox dropdown, read its option list from the popup, then
// close it — so the agent knows the valid choices before composing an answer.
// Options are scoped to the listbox THIS combobox controls (via aria-controls /
// aria-owns); reading `[role=option]` globally would capture an unrelated open
// popup (e.g. the phone widget's country list) and pollute every field.
async function harvestComboboxOptions(page: BrowserPage, fields: DetectedField[]): Promise<void> {
  // Dismiss any popup already open (e.g. the intl-tel-input country dropdown).
  await page.keyboard.press("Escape").catch(() => undefined);

  for (const field of fields) {
    if (!field.combobox || field.options.length > 0) continue;
    const contexts = orderedContexts(page, field.frameUrl);
    for (const ctx of contexts) {
      let locator: BrowserLocator;
      try {
        locator = ctx.locator(field.selector).first();
        if (!(await locatorUsable(locator))) continue;
      } catch {
        continue; // selector wasn't valid CSS in this context
      }
      try {
        await locator.scrollIntoViewIfNeeded().catch(() => undefined);
        await locator.click({ timeout: 2500 });
        await page.waitForTimeout(400);

        const listboxId =
          (await locator.getAttribute("aria-controls").catch(() => null)) ||
          (await locator.getAttribute("aria-owns").catch(() => null));

        let raw: string[] = [];
        if (listboxId) {
          raw = await ctx
            .locator(`[id="${listboxId}"] [role="option"], [id="${listboxId}"][role="listbox"] [role="option"]`)
            .allInnerTexts()
            .catch(() => []);
        }
        // Only fall back to a global read when the field controls no listbox of its
        // own AND exactly one listbox is open (so we cannot grab the wrong popup).
        if (!raw.length) {
          const listboxes = ctx.locator('[role="listbox"]');
          if ((await listboxes.count().catch(() => 0)) === 1) {
            raw = await listboxes.first().locator('[role="option"]').allInnerTexts().catch(() => []);
          }
        }

        const cleaned = raw.map((o) => o.replace(/\s+/g, " ").trim()).filter(Boolean);
        if (cleaned.length) field.options = Array.from(new Set(cleaned)).slice(0, 60);

        await locator.press("Escape").catch(() => page.keyboard.press("Escape").catch(() => undefined));
        await page.waitForTimeout(120);
      } catch {
        await page.keyboard.press("Escape").catch(() => undefined);
      }
      break; // resolved this field in this context
    }
  }
}

// ─── Persistent apply session ────────────────────────────────────────────────
// The whole point: keep ONE browser/page alive across inspect → fill → retry →
// code-entry, instead of closing and relaunching (which re-navigates the form and
// re-fills every field from scratch, burning tokens and tripping anti-bot scoring).
// The session is closed only on a confirmed submit or an explicit teardown.

interface ApplySession {
  browser: Browser;
  page: BrowserPage;
  atsHint: string;
  /** Original apply URL this session was opened for (used to decide reuse). */
  applyLink: string;
  /** Keys of instructions already filled successfully in THIS live page, so a
   *  retry only fills the corrected fields instead of re-typing the whole form. */
  filledKeys: Set<string>;
}

let activeSession: ApplySession | null = null;

function instrKey(instr: FillInstruction): string {
  return `${instr.frameUrl ?? "main"}|${instr.selector}|${(instr.label ?? "").replace(/\s+/g, " ").trim().toLowerCase()}`;
}

/** Two URLs point at the same application (ignoring the /application suffix and
 *  trailing slashes) so an inspect session can be reused by the submit call. */
function sameJob(a: string, b: string): boolean {
  const norm = (u: string) => u.replace(/\/application\/?$/, "").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

function sessionAlive(s: ApplySession | null): s is ApplySession {
  try {
    return !!s && s.browser.isConnected() && !s.page.isClosed();
  } catch {
    return false;
  }
}

export async function closeApplySession(): Promise<void> {
  const s = activeSession;
  activeSession = null;
  if (s) await s.browser.close().catch(() => undefined);
}

/** Reuse the live session if it is for the same job; otherwise tear down any stale
 *  one and open a fresh browser at the form. The returned page is already on the
 *  application form. */
async function getOrOpenSession(applyLink: string): Promise<ApplySession> {
  if (sessionAlive(activeSession) && sameJob(activeSession.applyLink, applyLink)) {
    return activeSession;
  }
  await closeApplySession();
  const { browser, page, atsHint } = await newBrowserPage(applyLink);
  activeSession = { browser, page, atsHint, applyLink, filledKeys: new Set() };
  return activeSession;
}

/** True when the instruction's target still holds a value on the live page (so a
 *  retry can skip re-typing it). Errs toward false so a genuinely cleared field
 *  gets refilled. */
async function instrStillFilled(page: BrowserPage, instr: FillInstruction): Promise<boolean> {
  if (instr.type === "radio" || instr.type === "checkbox") return false; // cheap to re-assert
  const locator = await findInstructionLocator(page, instr).catch(() => null);
  if (!locator) return false;
  return verifyFilled(locator, instr).catch(() => false);
}

// ─── Email verification code (e.g. "enter the code we emailed you") ──────────
const EMAIL_CODE_TEXT =
  /(verification|confirmation|security|one[\s-]*time|access|login|sign[\s-]*in)\s+code|code\s+(we\s+)?(sent|e-?mailed|texted)|enter\s+the\s+code|check\s+your\s+e-?mail|\b6[\s-]*digit\b|\bone[\s-]*time\s+password\b|\bOTP\b/i;

async function findEmailCodeField(page: BrowserPage): Promise<{ selector: string; frameUrl?: string } | null> {
  for (const ctx of allContexts(page)) {
    const hit = await ctx
      .evaluate(`(() => {
        const clean = (t) => (t || '').replace(/\\s+/g, ' ').trim();
        const inputs = Array.from(document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button])'));
        for (const el of inputs) {
          if (el.offsetParent === null) continue;
          const hay = ((el.name||'')+' '+(el.id||'')+' '+(el.getAttribute('aria-label')||'')+' '+(el.placeholder||'')+' '+(el.getAttribute('autocomplete')||'')).toLowerCase();
          if (/code|otp|one[-\\s]?time|verif|2fa|mfa/.test(hay)) {
            const id = el.getAttribute('id');
            const sel = id ? '#'+id : el.getAttribute('name') ? el.tagName.toLowerCase()+'[name="'+el.getAttribute('name')+'"]' : '';
            if (sel) return sel;
          }
        }
        return null;
      })()`)
      .catch(() => null);
    if (hit) {
      const frameUrl = ctx === page ? undefined : contextUrl(ctx);
      return { selector: String(hit), ...(frameUrl ? { frameUrl } : {}) };
    }
  }
  return null;
}

/** Does the current page show a "we emailed you a code" gate AND have a field to
 *  type it into? Only then do we ask the user — we must not stall on every form. */
async function detectEmailCodeRequest(page: BrowserPage): Promise<{ selector: string; frameUrl?: string } | null> {
  const body = await allBodyText(page);
  if (!EMAIL_CODE_TEXT.test(body)) return null;
  return findEmailCodeField(page);
}

/** Enter a user-supplied verification code into the live session and try to
 *  confirm/submit it — no browser relaunch, the same page the user was waiting on. */
export async function submitEmailCode(code: string): Promise<SubmitResult> {
  if (!sessionAlive(activeSession)) {
    return {
      success: false,
      screenshotPath: "",
      pageTitle: "",
      confirmedText: "",
      error: "No live application session is open. Re-run the apply flow before entering a code.",
    };
  }
  const page = activeSession.page;
  const target = await findEmailCodeField(page);
  if (!target) {
    const imgPath = screenshotPath("nocodefield");
    await page.screenshot({ path: imgPath, fullPage: false }).catch(() => undefined);
    return {
      success: false,
      screenshotPath: imgPath,
      pageTitle: await page.title().catch(() => ""),
      confirmedText: "",
      error: "Could not find a code input on the current page.",
      sessionOpen: true,
    };
  }

  try {
    await fillOneField(page, { selector: target.selector, value: code.trim(), type: "text", ...(target.frameUrl ? { frameUrl: target.frameUrl } : {}) });
  } catch (err) {
    return {
      success: false,
      screenshotPath: "",
      pageTitle: await page.title().catch(() => ""),
      confirmedText: "",
      error: `Could not enter the code: ${err instanceof Error ? err.message : String(err)}`,
      sessionOpen: true,
    };
  }

  // Most code gates auto-advance; if not, click the verify/continue/submit button.
  const codeSubmitted = await clickVerifyOrSubmit(page);
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => page.waitForTimeout(2500));

  const afterPath = screenshotPath("postcode");
  await page.screenshot({ path: afterPath, fullPage: false }).catch(() => undefined);
  const bodyText = await allBodyText(page);
  const confirmed = /thank|submitted|received|success|application\s+complete|verified|we have received/i.test(bodyText);
  if (confirmed) await closeApplySession();

  return {
    success: confirmed,
    screenshotPath: afterPath,
    pageTitle: await page.title().catch(() => ""),
    confirmedText: bodyText.slice(0, 600),
    submitted: codeSubmitted,
    ...(confirmed ? {} : { sessionOpen: true, error: "Code entered, but no confirmation detected yet." }),
  };
}

async function clickVerifyOrSubmit(page: BrowserPage): Promise<boolean> {
  const names = [/verify/i, /confirm/i, /continue/i, /submit/i, /next/i, /done/i];
  for (const ctx of allContexts(page)) {
    for (const name of names) {
      for (const locator of [
        ctx.getByRole("button", { name }).first(),
        ctx.getByRole("link", { name }).first(),
      ]) {
        if (await locatorUsable(locator)) {
          await moveMouseToLocator(page, locator);
          await locator.click().catch(() => undefined);
          return true;
        }
      }
    }
  }
  // Fall back to pressing Enter in case the code field auto-submits.
  await page.keyboard.press("Enter").catch(() => undefined);
  return false;
}

export async function inspectForm(applyLink: string): Promise<InspectResult> {
  // Open (or reuse) the persistent session and KEEP it open — the submit call will
  // fill into this same live page instead of relaunching and re-navigating.
  const session = await getOrOpenSession(applyLink);
  const { page, atsHint } = session;
  session.filledKeys.clear(); // a fresh inspect means nothing is filled yet

  try {
    // Two-pass scroll: trigger lazy-loaded content, then return to top for field extraction.
    await page.evaluate("window.scrollTo(0, document.body.scrollHeight)").catch(() => undefined);
    await page.waitForTimeout(800);
    await page.evaluate("window.scrollTo(0, 0)").catch(() => undefined);
    await page.waitForTimeout(400);

    await waitForFormFields(page, 12_000).catch(() => undefined);

    // For Ashby (React-rendered), wait for networkidle before extracting fields.
    if (atsHint === "ashby") {
      await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
    }

    let fields = await extractAllFields(page);

    // Strategy B: Ashby/React shadow inputs not captured by standard DOM traversal.
    if (atsHint === "ashby") {
      const ashbyLocators = page.locator(
        '[data-testid*="input" i], [data-testid*="field" i], [class*="Input"], [class*="Field"]',
      );
      const count = await ashbyLocators.count().catch(() => 0);
      const labelsSeen = new Set(fields.map((f) => f.label.toLowerCase()));
      for (let i = 0; i < count; i++) {
        try {
          const loc = ashbyLocators.nth(i);
          const ariaLabel = (await loc.getAttribute("aria-label").catch(() => null)) ?? "";
          const placeholder = (await loc.getAttribute("placeholder").catch(() => null)) ?? "";
          const testId = (await loc.getAttribute("data-testid").catch(() => null)) ?? "";
          const label = ariaLabel || placeholder || testId;
          if (!label || labelsSeen.has(label.toLowerCase())) continue;
          const tagName = (await loc.evaluate((el: any) => el.tagName.toLowerCase()).catch(() => "")) as string;
          if (!tagName || !["input", "textarea", "select"].includes(tagName)) continue;
          fields.push({
            selector: testId ? `[data-testid="${testId}"]` : `[aria-label="${ariaLabel}"]`,
            label,
            type: tagName === "textarea" ? "textarea" : tagName === "select" ? "select" : "text",
            placeholder,
            required: false,
            options: [],
          });
          labelsSeen.add(label.toLowerCase());
        } catch {
          // Skip unreadable locators.
        }
      }
    }

    // Harvest the option list for custom dropdowns (react-select/ARIA comboboxes)
    // so the agent answers with a valid choice. Their options only render on open.
    await harvestComboboxOptions(page, fields);

    const imgPath = screenshotPath("inspect");
    await page.screenshot({ path: imgPath, fullPage: false });

    const result: InspectResult = {
      url: page.url(),
      pageTitle: await page.title(),
      atsHint,
      fields,
      screenshotPath: imgPath,
    };

    saveFormState({
      ...result,
      originalUrl: applyLink,
      timestamp: Date.now(),
    });

    return result;
  } catch (err) {
    // A failed inspect should not leave a zombie browser around.
    await closeApplySession();
    throw err;
  }
}

export async function fillAndSubmit(
  applyLink: string,
  instructions: FillInstruction[],
  dryRun: boolean,
): Promise<SubmitResult> {
  const savedState = loadFormState();
  const effectiveInstructions =
    instructions.length > 0 ? instructions : savedState?.draftInstructions ?? [];
  const targetUrl = instructions.length > 0 ? applyLink : savedState?.url || applyLink;

  if (effectiveInstructions.length === 0) {
    return {
      success: false,
      screenshotPath: "",
      pageTitle: "",
      confirmedText: "",
      error: "No fill instructions were provided and no saved apply draft was found.",
      failedFields: [],
    };
  }

  // Which detected fields are required? Used to decide whether a fill failure
  // should block submission. An optional field that fails to fill must NOT stop a
  // real application (e.g. a stray widget input); a required one must.
  const requiredKeys = new Set(
    (savedState?.fields ?? [])
      .filter((f) => f.required)
      .flatMap((f) => [f.selector, f.label.replace(/\s+/g, " ").trim().toLowerCase()]),
  );
  const isRequiredInstr = (instr: FillInstruction): boolean =>
    requiredKeys.has(instr.selector) ||
    requiredKeys.has((instr.label ?? "").replace(/\s+/g, " ").trim().toLowerCase());

  // Reuse the live session opened by inspect (or a prior retry). The page is
  // already on the form, prior fields keep their values, and we only fill what is
  // still missing — no relaunch, no re-navigation, no re-typing the whole form.
  const session = await getOrOpenSession(targetUrl);
  const { page } = session;

  try {
    const failedFields: NonNullable<SubmitResult["failedFields"]> = [];
    let filledCount = 0;

    for (const instr of effectiveInstructions) {
      const key = instrKey(instr);
      // On a retry the page still holds everything filled last pass — skip those
      // and only (re)fill the corrected/missing fields. This is the core token
      // saving: a validation-error retry touches one field, not the whole form.
      if (session.filledKeys.has(key) && (await instrStillFilled(page, instr))) {
        filledCount += 1;
        continue;
      }
      try {
        await fillOneField(page, instr);
        session.filledKeys.add(key);
        filledCount += 1;
        // Pause a varying beat between fields, and occasionally scroll as if
        // reading ahead — steady 150ms ticks are a classic bot signature.
        await humanPause(page, 200, 700);
        if (Math.random() < 0.3) await humanScroll(page);
      } catch (err) {
        session.filledKeys.delete(key);
        failedFields.push({
          selector: instr.selector,
          label: instr.label,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const beforePath = screenshotPath(dryRun ? "dryrun" : "prefill");
    // Dry-run produces a review screenshot — capture the whole form, not just the
    // viewport, so every filled field is visible.
    await page.screenshot({ path: beforePath, fullPage: dryRun });

    // Block only when a REQUIRED field could not be filled. Optional failures are
    // surfaced in failedFields but do not stop submission.
    const requiredFailures = failedFields.filter((f) =>
      isRequiredInstr({ selector: f.selector, value: "", label: f.label }),
    );
    if (requiredFailures.length > 0) {
      // Keep the session open: the agent can recompose the offending fields and
      // call again — they fill into this same page rather than a fresh reload.
      return {
        success: false,
        screenshotPath: beforePath,
        pageTitle: await page.title(),
        confirmedText: `Filled ${filledCount} fields, but ${requiredFailures.length} required field(s) could not be filled.`,
        error: "Required fields could not be filled. Review failedFields, recompose only those, and call apply_submit_form again — the same live session stays open.",
        filledCount,
        failedFields,
        submitted: false,
        sessionOpen: true,
      };
    }

    if (dryRun) {
      // Dry run leaves the filled form on screen for review; the session stays open
      // so a follow-up live submit reuses it instead of refilling from scratch.
      return {
        success: false,
        screenshotPath: beforePath,
        pageTitle: await page.title(),
        confirmedText: "Dry run - form filled but not submitted.",
        filledCount,
        failedFields,
        submitted: false,
        sessionOpen: true,
      };
    }

    const submitted = await clickSubmit(page);
    if (!submitted) {
      const imgPath = screenshotPath("nosubmit");
      await page.screenshot({ path: imgPath, fullPage: false });
      return {
        success: false,
        screenshotPath: imgPath,
        pageTitle: await page.title(),
        confirmedText: "",
        error: "Could not locate a submit button. Review the screenshot and submit manually.",
        filledCount,
        failedFields,
        submitted: false,
        sessionOpen: true,
      };
    }

    await page
      .waitForLoadState("networkidle", { timeout: 10_000 })
      .catch(() => page.waitForTimeout(4000));

    const afterPath = screenshotPath("postsubmit");
    await page.screenshot({ path: afterPath, fullPage: false });

    const bodyText = await allBodyText(page);
    const confirmed =
      /thank|submitted|received|success|application\s+complete|we.ll be in touch|we have received/i.test(bodyText);

    if (confirmed) {
      // Done — tear the session down so the next application starts clean.
      await page.waitForTimeout(1500).catch(() => undefined);
      await closeApplySession();
      return {
        success: true,
        screenshotPath: afterPath,
        pageTitle: "",
        confirmedText: bodyText.slice(0, 600),
        filledCount,
        failedFields,
        submitted: true,
      };
    }

    // Unconfirmed: the form may be gated behind an emailed verification code. If so,
    // surface needsEmailCode so the agent asks the user, then enters it via
    // apply_submit_code in this same live session.
    const codeField = await detectEmailCodeRequest(page);
    if (codeField) {
      return {
        success: false,
        screenshotPath: afterPath,
        pageTitle: await page.title(),
        confirmedText: bodyText.slice(0, 600),
        filledCount,
        failedFields,
        submitted: true,
        sessionOpen: true,
        needsEmailCode: true,
        error: "The form is asking for a verification code sent to your email. Ask the user for that code and call apply_submit_code — the browser stays open.",
      };
    }

    // Clicking submit does not mean the form went through — the ATS may have
    // re-rendered the same page with validation errors (a missed phone number, a
    // dropdown that never committed). When unconfirmed, gather those errors so the
    // agent can reason about which field it missed and refill it on the next pass —
    // in the SAME open session.
    const validationErrors = await detectValidationErrors(page);

    return {
      success: false,
      screenshotPath: afterPath,
      pageTitle: await page.title(),
      confirmedText: bodyText.slice(0, 600),
      filledCount,
      failedFields,
      submitted: true,
      sessionOpen: true,
      ...(validationErrors.length ? { validationErrors } : {}),
      error: validationErrors.length
        ? `Not submitted — the form reported ${validationErrors.length} validation issue(s). Recompose ONLY those fields and call apply_submit_form again; the same live session stays open and only the corrected fields are re-entered.`
        : "Submitted, but no confirmation text was detected. The session stays open if you need to correct a field.",
    };
  } catch (err) {
    // Unexpected failure — close the session so we don't leak a browser.
    await closeApplySession();
    throw err;
  }
}
