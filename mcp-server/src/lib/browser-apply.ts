import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

type BrowserPage = import("playwright").Page;
type BrowserFrame = import("playwright").Frame;
type BrowserLocator = import("playwright").Locator;
type FormContext = BrowserPage | BrowserFrame;

export interface DetectedField {
  selector: string;
  label: string;
  type: string;
  placeholder: string;
  required: boolean;
  options: string[];
  frameUrl?: string;
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

function detectAts(url: string): string {
  if (url.includes("greenhouse.io") || url.includes("grnh.se")) return "greenhouse";
  if (url.includes("lever.co")) return "lever";
  if (url.includes("ashbyhq.com")) return "ashby";
  if (url.includes("myworkdayjobs.com") || url.includes("workday.com")) return "workday";
  if (url.includes("smartrecruiters.com")) return "smartrecruiters";
  if (url.includes("jobvite.com")) return "jobvite";
  return "unknown";
}

function normalizeFormUrl(applyLink: string, atsHint: string): string {
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
    const type = tag === 'SELECT' ? 'select'
      : tag === 'TEXTAREA' || el.getAttribute('contenteditable') === 'true' ? 'textarea'
      : role === 'radio' ? 'radio'
      : role === 'checkbox' ? 'checkbox'
      : inputType || 'text';

    if (['hidden', 'submit', 'button', 'image', 'reset'].includes(type)) continue;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;

    const selector = uniqueSelector(el);
    const groupKey = type === 'radio' && el.name ? 'radio:' + el.name : selector;
    if (seen.has(groupKey)) continue;
    seen.add(groupKey);

    fields.push({
      selector,
      label: labelFromRelatedElement(el),
      type,
      placeholder: clean(el.placeholder || ''),
      required: requiredFromContext(el),
      options: type === 'select' ? selectOptions(el) : type === 'radio' ? radioOptions(el) : [],
    });
  }

  return fields;
}`;

async function scrollPageToLoad(page: BrowserPage): Promise<void> {
  await page
    .evaluate(`async () => {
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const max = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      const step = Math.max(Math.floor(window.innerHeight * 0.8), 500);
      for (let y = 0; y <= max + step; y += step) {
        window.scrollTo(0, y);
        await delay(180);
      }
      window.scrollTo(0, 0);
    }`)
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
    const fields = (await ctx.evaluate(EXTRACT_FIELDS_SCRIPT)) as DetectedField[];
    return fields.map((field) => ({ ...field, ...(frameUrl ? { frameUrl } : {}) }));
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
  return fields.filter((field) => {
    const key = `${field.frameUrl ?? "main"}|${field.selector}|${field.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function looksLikeApplicationForm(fields: DetectedField[]): boolean {
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
      contextUrl(ctx).includes("/application"),
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

async function clickChoice(page: BrowserPage, instr: FillInstruction, choiceType: "radio" | "checkbox"): Promise<void> {
  const needle = instr.value.toLowerCase();
  const contexts = orderedContexts(page, instr.frameUrl);

  for (const ctx of contexts) {
    const roleLocator = ctx
      .getByRole(choiceType, { name: new RegExp(escapeRegExp(instr.value), "i") })
      .first();
    if (await locatorUsable(roleLocator)) {
      await roleLocator.click();
      return;
    }
  }

  const groupLocator = await findInstructionLocator(page, instr);
  const groupName = await groupLocator?.getAttribute("name").catch(() => null);

  for (const ctx of contexts) {
    const selector = groupName
      ? `input[type="${choiceType}"][name="${groupName}"]`
      : `input[type="${choiceType}"]`;
    const choices = await ctx.locator(selector).all().catch(() => []);
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
      await page.waitForTimeout(1000);
      const uploadConfirmed = await fileLocator
        .evaluate((el: any) => (el.files?.length ?? 0) > 0)
        .catch(() => false);
      if (!uploadConfirmed) {
        console.warn("[apply] resume upload could not be confirmed — files.length is 0 after 1 s");
      }
      return;
    }

    case "select":
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
      await locator!.fill(instr.value);
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

  for (const ctx of allContexts(page)) {
    for (const selector of ['button[type="submit"]', 'input[type="submit"]']) {
      const locator = ctx.locator(selector).first();
      if (await locatorUsable(locator)) {
        await locator.scrollIntoViewIfNeeded().catch(() => undefined);
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

async function newBrowserPage(applyLink: string): Promise<{ browser: import("playwright").Browser; page: BrowserPage; atsHint: string }> {
  let playwright;
  try {
    playwright = await import("playwright");
  } catch {
    throw new Error(
      "Playwright is not installed. Run: npm i -g jobsync-mcp@latest && npx playwright install chromium",
    );
  }

  const browser = await playwright.chromium.launch({ headless: false });
  const ctx = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });
  const startPage = await ctx.newPage();
  const opened = await openApplicationForm(startPage, applyLink);
  return { browser, page: opened.page, atsHint: opened.atsHint };
}

export async function inspectForm(applyLink: string): Promise<InspectResult> {
  const { browser, page, atsHint } = await newBrowserPage(applyLink);

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
            selector: `[data-testid="${testId}"]` || `[aria-label="${ariaLabel}"]`,
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
  } finally {
    await browser.close();
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

  const { browser, page } = await newBrowserPage(targetUrl);

  try {
    const failedFields: SubmitResult["failedFields"] = [];
    let filledCount = 0;

    for (const instr of effectiveInstructions) {
      try {
        await fillOneField(page, instr);
        filledCount += 1;
        await page.waitForTimeout(150);
      } catch (err) {
        failedFields.push({
          selector: instr.selector,
          label: instr.label,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const beforePath = screenshotPath(dryRun ? "dryrun" : "prefill");
    await page.screenshot({ path: beforePath, fullPage: false });

    if (failedFields.length > 0) {
      return {
        success: false,
        screenshotPath: beforePath,
        pageTitle: await page.title(),
        confirmedText: `Filled ${filledCount} fields, but ${failedFields.length} field(s) could not be filled.`,
        error: "Some fields could not be filled. Review failedFields before submitting.",
        filledCount,
        failedFields,
        submitted: false,
      };
    }

    if (dryRun) {
      return {
        success: false,
        screenshotPath: beforePath,
        pageTitle: await page.title(),
        confirmedText: "Dry run - form filled but not submitted.",
        filledCount,
        failedFields,
        submitted: false,
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

    return {
      success: confirmed,
      screenshotPath: afterPath,
      pageTitle: await page.title(),
      confirmedText: bodyText.slice(0, 600),
      filledCount,
      failedFields,
      submitted: true,
      ...(confirmed ? {} : { error: "Submitted, but no confirmation text was detected." }),
    };
  } finally {
    await page.waitForTimeout(2000).catch(() => undefined);
    await browser.close();
  }
}
