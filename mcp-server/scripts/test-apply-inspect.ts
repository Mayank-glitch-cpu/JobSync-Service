/**
 * Manual test harness — Phase 1 (extract) + Phase 2 (identify answers).
 * Mirrors what apply_inspect_form + apply_fill_fields do, without an LLM.
 * Run: npx tsx scripts/test-apply-inspect.ts <applyLink>
 */
import { inspectForm, loadFormState } from "../src/lib/browser-apply.js";
import { readPersonalProfile } from "../src/lib/personal-profile.js";
import { readProfileFile } from "../src/lib/profile.js";
import { fillFields } from "../src/lib/ai-fill.js";

const applyLink = process.argv[2];
if (!applyLink) throw new Error("Usage: tsx test-apply-inspect.ts <applyLink>");

console.log("\n=== PHASE 1: inspecting form ===");
const inspect = await inspectForm(applyLink);
console.log("URL:        ", inspect.url);
console.log("ATS hint:   ", inspect.atsHint);
console.log("Field count:", inspect.fields.length);
console.log("Screenshot: ", inspect.screenshotPath);
console.log("\nDetected fields:");
for (const f of inspect.fields) {
  const opts = f.options.length ? `  options=[${f.options.join(" | ")}]` : "";
  console.log(`  - [${f.type}]${f.required ? " *req*" : ""} "${f.label}"  (${f.selector})${opts}`);
}

console.log("\n=== PHASE 2: map profile + identify what needs answers ===");
const state = loadFormState();
if (!state) throw new Error("No saved form state");
const profile = readPersonalProfile();
const experience = readProfileFile("experience");
const skills = readProfileFile("skills");
const projects = readProfileFile("projects");

const { instructions, unansweredFields, unfilledRequired } = fillFields(
  state.fields,
  profile,
  "Cohere",
  "this role",
  experience,
  skills,
  projects,
);

console.log("\nStandard fields auto-mapped from profile:");
for (const i of instructions) {
  const v = i.type === "file" ? i.value : String(i.value).slice(0, 60);
  console.log(`  ✓ "${i.label}" = ${v}  [${i.type}]`);
}

console.log("\nFields the agent must compose answers for:");
for (const f of unansweredFields) {
  const opts = f.options.length ? `  choose=[${f.options.join(" | ")}]` : "";
  console.log(`  ? [${f.type}]${f.required ? " *req*" : ""} "${f.label}"  (${f.selector})${opts}`);
}

console.log("\nHard-blocked required (genuinely unanswerable):", unfilledRequired);
console.log("\nDone. Screenshot saved at:", inspect.screenshotPath);
