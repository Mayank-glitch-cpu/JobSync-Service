// Snapshot a real day of ATS responses into a fixture directory for the eval
// harness. Records BOTH the board-list calls (fast-path fetchers) and the
// per-job liveness API calls (link verifier), so replay covers discovery and
// the audit's link checks.
//
// Usage:
//   tsx scripts/record-fixtures.ts \
//     --dir evals/fixtures/2026-06-10 \
//     --greenhouse stripe,airbnb \
//     --lever ramp \
//     --ashby openai \
//     --workday https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite
//
// After recording, set in the eval container:
//   JOBSYNC_FIXTURE_DIR=<dir> JOBSYNC_FIXTURE_MODE=replay JOBSYNC_FAKE_NOW=<recordedDate+6h>

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { FixtureStore, installFixtureFetch, isAtsUrl } from "../src/lib/eval/fixture-fetch.js";
import { fetchAshby, fetchGreenhouse, fetchLever, fetchWorkday } from "../src/lib/fast-path.js";
import { checkJobLinkLive } from "../src/tools/link-check-tools.js";
import type { RawJob } from "../src/lib/types.js";

interface Args {
  dir: string;
  greenhouse: string[];
  lever: string[];
  ashby: string[];
  workday: string[];
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const list = (flag: string): string[] =>
    (get(flag) ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  const dir = get("--dir");
  if (!dir) {
    console.error("ERROR: --dir <fixtureDir> is required.");
    process.exit(1);
  }
  return {
    dir,
    greenhouse: list("--greenhouse"),
    lever: list("--lever"),
    ashby: list("--ashby"),
    workday: list("--workday"),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const store = new FixtureStore(args.dir);
  const restore = installFixtureFetch({ store, mode: "record", shouldIntercept: isAtsUrl });

  const recorded: { source: string; slug: string; jobs: number; error?: string }[] = [];
  const allJobs: RawJob[] = [];

  const pulls: Array<[string, string, () => Promise<RawJob[]>]> = [
    ...args.greenhouse.map((s) => ["greenhouse", s, () => fetchGreenhouse(s)] as [string, string, () => Promise<RawJob[]>]),
    ...args.lever.map((s) => ["lever", s, () => fetchLever(s)] as [string, string, () => Promise<RawJob[]>]),
    ...args.ashby.map((s) => ["ashby", s, () => fetchAshby(s)] as [string, string, () => Promise<RawJob[]>]),
    ...args.workday.map((u) => ["workday", u, () => fetchWorkday(u)] as [string, string, () => Promise<RawJob[]>]),
  ];

  for (const [source, slug, fn] of pulls) {
    try {
      const jobs = await fn();
      allJobs.push(...jobs);
      recorded.push({ source, slug, jobs: jobs.length });
      console.log(`✓ ${source}:${slug} — ${jobs.length} jobs`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      recorded.push({ source, slug, jobs: 0, error: msg });
      console.warn(`✗ ${source}:${slug} — ${msg}`);
    }
  }

  // Record per-job liveness responses so the audit's link checks replay too.
  console.log(`Recording liveness for ${allJobs.length} job links…`);
  let live = 0;
  for (const job of allJobs) {
    try {
      const status = await checkJobLinkLive(job.applyLink);
      if (status.active) live++;
    } catch {
      /* recorded as whatever the verifier observed */
    }
  }

  restore();

  // Write a ground-truth manifest the eval reference solutions can build on.
  const groundTruth = {
    recordedAt: new Date().toISOString(),
    sources: recorded,
    jobs: allJobs.map((j) => ({
      id: j.id,
      applyLink: j.applyLink,
      positionTitle: j.positionTitle,
      company: j.company,
      location: j.location,
      datePosted: j.datePosted,
    })),
  };
  writeFileSync(join(args.dir, "ground-truth.json"), JSON.stringify(groundTruth, null, 2));

  console.log(
    `\nDone. ${store.size} HTTP responses recorded, ${allJobs.length} jobs, ${live} live links.\n` +
      `Fixtures + ground-truth.json written to ${args.dir}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
