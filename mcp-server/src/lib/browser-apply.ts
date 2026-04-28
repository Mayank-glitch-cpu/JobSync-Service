import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface DetectedField {
  selector: string;
  label: string;
  type: string;        // "text" | "email" | "tel" | "file" | "select" | "textarea" | "radio" | "checkbox"
  placeholder: string;
  required: boolean;
  options: string[];   // populated for select / radio
}

export interface InspectResult {
  url: string;
  pageTitle: string;
  atsHint: string;     // "greenhouse" | "lever" | "ashby" | "workday" | "unknown"
  fields: DetectedField[];
  screenshotPath: string;
}

export interface FillInstruction {
  selector: string;
  value: string;
  // "file" — set file input; "select" — pick by option text; "radio" — click matching option;
  // "checkbox" — check/uncheck; "text" (default) — type into input/textarea
  type?: string;
}

export interface SubmitResult {
  success: boolean;
  screenshotPath: string;
  pageTitle: string;
  confirmedText: string;
  error?: string;
}

function screenshotDir(): string {
  const dir = join(tmpdir(), "jobsync-screenshots");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

// Candidates for the "Apply" CTA on job listing pages (before the actual form).
const APPLY_BUTTON_SELECTORS = [
  'a[href*="/application"]',
  'a[href*="apply"]',
  'button:has-text("Apply for this Job")',
  'button:has-text("Apply Now")',
  'button:has-text("Apply")',
  'a:has-text("Apply for this Job")',
  'a:has-text("Apply Now")',
  'a:has-text("Apply")',
  '[data-testid*="apply"]',
  '[class*="apply-button"]',
  '[id*="apply-button"]',
];

/**
 * Scroll the page and click an Apply CTA if one exists.
 * Returns true if a button was found and clicked (navigation likely happened).
 */
async function clickApplyButtonIfPresent(page: import("playwright").Page): Promise<boolean> {
  // Scroll through the page so lazy-rendered buttons become visible
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
  await page.waitForTimeout(600);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(600);
  await page.evaluate(() => window.scrollTo(0, 0));

  for (const sel of APPLY_BUTTON_SELECTORS) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1000 })) {
        // If it's a link that opens to a new tab, capture it
        const [newPage] = await Promise.all([
          page.context().waitForEvent("page", { timeout: 3000 }).catch(() => null),
          btn.click(),
        ]);
        if (newPage) {
          await newPage.waitForLoadState("domcontentloaded").catch(() => {});
          // Navigate the original page to the new URL instead
          await page.goto(newPage.url(), { waitUntil: "domcontentloaded", timeout: 30_000 });
          await newPage.close().catch(() => {});
        } else {
          // Same-page navigation
          await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
        }
        return true;
      }
    } catch { /* try next selector */ }
  }
  return false;
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

// Runs inside page.evaluate — must be serialisable (no closures over outer scope).
// Returns a plain JSON-serialisable array of field descriptors.
const EXTRACT_FIELDS_SCRIPT = `() => {
  function getLabel(el) {
    // 1. aria-label / aria-labelledby
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const lbEl = document.getElementById(labelledBy);
      if (lbEl) return lbEl.innerText.trim();
    }
    // 2. <label for="id">
    if (el.id) {
      const lf = document.querySelector('label[for="' + el.id + '"]');
      if (lf) return lf.innerText.trim();
    }
    // 3. ancestor <label>
    let p = el.parentElement;
    for (let i = 0; i < 5; i++) {
      if (!p) break;
      if (p.tagName === 'LABEL') return p.innerText.replace(el.value || '', '').trim();
      p = p.parentElement;
    }
    // 4. placeholder fallback
    return el.placeholder || el.name || '';
  }

  function uniqueSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    if (el.name) return el.tagName.toLowerCase() + '[name="' + el.name + '"]';
    // Build nth-child path (max 4 levels)
    const parts = [];
    let cur = el;
    for (let i = 0; i < 4 && cur && cur !== document.body; i++) {
      const parent = cur.parentElement;
      if (!parent) break;
      const siblings = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
      const idx = siblings.indexOf(cur);
      parts.unshift(cur.tagName.toLowerCase() + (siblings.length > 1 ? ':nth-of-type(' + (idx + 1) + ')' : ''));
      cur = parent;
    }
    return parts.join(' > ');
  }

  const inputs = Array.from(document.querySelectorAll('input, textarea, select'));
  const seen = new Set();
  const fields = [];

  for (const el of inputs) {
    const type = el.tagName === 'SELECT' ? 'select'
      : el.tagName === 'TEXTAREA' ? 'textarea'
      : (el.type || 'text').toLowerCase();

    if (['hidden', 'submit', 'button', 'image', 'reset'].includes(type)) continue;

    const sel = uniqueSelector(el);
    if (seen.has(sel)) continue;
    seen.add(sel);

    const options = type === 'select'
      ? Array.from(el.options).map(o => o.text.trim()).filter(Boolean)
      : type === 'radio'
        ? Array.from(document.querySelectorAll('input[name="' + el.name + '"]'))
            .map(r => { const lbl = document.querySelector('label[for="' + r.id + '"]'); return lbl ? lbl.innerText.trim() : r.value; })
        : [];

    fields.push({
      selector: sel,
      label: getLabel(el),
      type,
      placeholder: el.placeholder || '',
      required: el.required || el.getAttribute('aria-required') === 'true',
      options,
    });
  }
  return fields;
}`;

export async function inspectForm(applyLink: string): Promise<InspectResult> {
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
  const page = await ctx.newPage();

  try {
    const atsHint = detectAts(applyLink);

    // Ashby job listing pages have no form — the form lives at {url}/application
    const formUrl =
      atsHint === "ashby" && !applyLink.endsWith("/application")
        ? applyLink.replace(/\/$/, "") + "/application"
        : applyLink;

    await page.goto(formUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

    // If the page has no form inputs yet, it's probably a listing page with an Apply CTA.
    // Scroll and click through to the actual application form.
    const hasInputs = await page.locator("input:not([type=hidden]), textarea, select").count().then(n => n > 0).catch(() => false);
    if (!hasInputs) {
      await clickApplyButtonIfPresent(page);
    }

    // Wait for form inputs to appear (handles React/JS-rendered forms and post-click navigation)
    try {
      await page.waitForSelector("input:not([type=hidden]), textarea, select", { timeout: 12_000 });
    } catch {
      // No inputs found — may be a multi-step modal or fully custom UI; proceed anyway
    }

    // For Greenhouse, the actual application form is often in an iframe
    if (atsHint === "greenhouse") {
      const frame = page.frameLocator('iframe[src*="greenhouse"]').first();
      try { await frame.locator("input").first().waitFor({ timeout: 5000 }); } catch { /* no iframe */ }
    }

    const fields = (await page.evaluate(EXTRACT_FIELDS_SCRIPT)) as DetectedField[];
    const imgPath = screenshotPath("inspect");
    await page.screenshot({ path: imgPath, fullPage: false });

    return {
      url: page.url(),
      pageTitle: await page.title(),
      atsHint,
      fields,
      screenshotPath: imgPath,
    };
  } finally {
    await browser.close();
  }
}

export async function fillAndSubmit(
  applyLink: string,
  instructions: FillInstruction[],
  dryRun: boolean,
): Promise<SubmitResult> {
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
  const page = await ctx.newPage();

  try {
    const atsHint = detectAts(applyLink);
    const formUrl =
      atsHint === "ashby" && !applyLink.endsWith("/application")
        ? applyLink.replace(/\/$/, "") + "/application"
        : applyLink;

    await page.goto(formUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

    // If no form inputs visible, scroll and click through the Apply CTA first
    const hasInputs = await page.locator("input:not([type=hidden]), textarea, select").count().then(n => n > 0).catch(() => false);
    if (!hasInputs) {
      await clickApplyButtonIfPresent(page);
    }

    // Wait for form inputs to appear before filling
    try {
      await page.waitForSelector("input:not([type=hidden]), textarea, select", { timeout: 12_000 });
    } catch {
      // proceed anyway
    }

    for (const instr of instructions) {
      try {
        const locator = page.locator(instr.selector).first();
        await locator.waitFor({ timeout: 5000 });

        switch (instr.type ?? "text") {
          case "file":
            await locator.setInputFiles(instr.value);
            break;
          case "select":
            await locator.selectOption({ label: instr.value });
            break;
          case "radio": {
            // Click the radio whose associated label matches value
            const radios = await page.locator(`input[type="radio"]`).all();
            for (const r of radios) {
              const id = await r.getAttribute("id");
              if (!id) continue;
              const lbl = page.locator(`label[for="${id}"]`);
              const lblText = await lbl.textContent().catch(() => "");
              if (lblText?.toLowerCase().includes(instr.value.toLowerCase())) {
                await r.check();
                break;
              }
            }
            break;
          }
          case "checkbox": {
            const checked = await locator.isChecked();
            const want = instr.value.toLowerCase() === "true";
            if (checked !== want) await locator.click();
            break;
          }
          default:
            await locator.fill(instr.value);
        }

        await page.waitForTimeout(200);
      } catch {
        // Non-fatal: log and continue to remaining fields
      }
    }

    const beforePath = screenshotPath("prefill");
    await page.screenshot({ path: beforePath, fullPage: false });

    if (dryRun) {
      return {
        success: false,
        screenshotPath: beforePath,
        pageTitle: await page.title(),
        confirmedText: "Dry run — form filled but not submitted.",
      };
    }

    // Click the primary submit button
    const submitCandidates = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Submit")',
      'button:has-text("Apply")',
      'button:has-text("Send Application")',
    ];

    let submitted = false;
    for (const sel of submitCandidates) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        submitted = true;
        break;
      }
    }

    if (!submitted) {
      const imgPath = screenshotPath("nosubmit");
      await page.screenshot({ path: imgPath, fullPage: false });
      return {
        success: false,
        screenshotPath: imgPath,
        pageTitle: await page.title(),
        confirmedText: "",
        error: "Could not locate a submit button. Review the screenshot and submit manually.",
      };
    }

    // Wait for confirmation page / success text
    await page.waitForTimeout(4000);
    const afterPath = screenshotPath("postsubmit");
    await page.screenshot({ path: afterPath, fullPage: false });

    const bodyText = await page.evaluate(() => document.body.innerText);
    const confirmed =
      /thank|submitted|received|success|application\s+complete/i.test(bodyText);

    return {
      success: confirmed,
      screenshotPath: afterPath,
      pageTitle: await page.title(),
      confirmedText: bodyText.slice(0, 400),
    };
  } finally {
    // Keep browser open briefly so the user can see the result
    await page.waitForTimeout(3000);
    await browser.close();
  }
}
