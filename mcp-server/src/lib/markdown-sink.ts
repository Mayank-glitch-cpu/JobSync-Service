// Alternative to Airtable: append jobs as a markdown table to a file.
// Each row is one job; we write a header block on first use and then
// append additional rows per run. Same field set as the Airtable schema
// so downstream tooling sees parity.

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ProcessedJob } from "./types.js";

const HEADER = `# JobSync — Jobs Log

| Date Posted | Company | Position | Location | Work Model | Industry | Tags | Apply Link | H1B | New Grad | Internship | Salary |
|---|---|---|---|---|---|---|---|---|---|---|---|
`;

function escape(v: string | null | undefined): string {
  if (!v) return "";
  return String(v).replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function jobRow(j: ProcessedJob): string {
  const cells = [
    (j.datePosted ?? "").split("T")[0] ?? "",
    escape(j.company),
    escape(j.positionTitle),
    escape(j.location),
    escape(j.workModel),
    escape(j.industry),
    escape(j.tags?.join(", ") ?? ""),
    escape(j.applyLink),
    j.h1bSponsored ? "✓" : "",
    j.isNewGrad ? "✓" : "",
    j.isInternship ? "✓" : "",
    escape(j.salary),
  ];
  return `| ${cells.join(" | ")} |`;
}

export function appendJobsToMarkdown(path: string, jobs: ProcessedJob[]): number {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(path)) writeFileSync(path, HEADER);
  const rows = jobs.map(jobRow).join("\n");
  if (rows) appendFileSync(path, rows + "\n");
  return jobs.length;
}
