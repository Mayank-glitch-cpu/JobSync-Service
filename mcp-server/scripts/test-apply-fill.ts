/**
 * Manual test harness — Phase 3 (fill + verify), DRY RUN (never submits).
 * Mirrors apply_submit_form with dryRun=true.
 * Run: npx tsx scripts/test-apply-fill.ts <applyLink>
 */
import { inspectForm, fillAndSubmit, saveApplyDraft } from "../src/lib/browser-apply.js";
import { readPersonalProfile } from "../src/lib/personal-profile.js";
import { readProfileFile } from "../src/lib/profile.js";
import { fillFields } from "../src/lib/ai-fill.js";

const applyLink = process.argv[2];
if (!applyLink) throw new Error("Usage: tsx test-apply-fill.ts <applyLink>");

console.log("=== Phase 1: inspect ===");
const inspect = await inspectForm(applyLink);
console.log(`detected ${inspect.fields.length} fields (ATS: ${inspect.atsHint})`);

const profile = readPersonalProfile();
const { instructions } = fillFields(
  inspect.fields,
  profile,
  "Cohere",
  "Member of Technical Staff, Search",
  readProfileFile("experience"),
  readProfileFile("skills"),
  readProfileFile("projects"),
);
saveApplyDraft(instructions, [], applyLink);
console.log(`built ${instructions.length} fill instructions`);

console.log("\n=== Phase 3: fill (DRY RUN — will NOT submit) ===");
const result = await fillAndSubmit(applyLink, instructions, /* dryRun */ true);
console.log("success:    ", result.success);
console.log("submitted:  ", result.submitted);
console.log("filledCount:", result.filledCount, "/", instructions.length);
console.log("confirmed:  ", result.confirmedText);
console.log("screenshot: ", result.screenshotPath);
if (result.failedFields?.length) {
  console.log("\nFAILED FIELDS:");
  for (const f of result.failedFields) console.log(`  ✗ "${f.label}" (${f.selector}): ${f.error}`);
}
