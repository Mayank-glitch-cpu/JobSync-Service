// Ported from backend/src/services/airtable-sync.ts. Pure functions only —
// the MCP tool layer handles the actual Airtable SDK calls.
// Keep in sync with legacy until retired.

import Airtable from "airtable";
import type { ProcessedJob, SyncedJob } from "./types.js";

export const INVALID_VALUES = [
  "unknown company",
  "unknown position",
  "unknown",
  "n/a",
  "none",
  "",
];

export interface ValidationResult {
  valid: boolean;
  reasons: string[];
}

export function validateJobForSync(job: ProcessedJob): ValidationResult {
  const reasons: string[] = [];
  if (!job.datePosted) reasons.push("missing datePosted");
  if (!job.positionTitle) reasons.push("missing positionTitle");
  if (!job.company) reasons.push("missing company");
  if (!job.applyLink) reasons.push("missing applyLink");

  const companyLower = (job.company || "").trim().toLowerCase();
  const titleLower = (job.positionTitle || "").trim().toLowerCase();
  if (INVALID_VALUES.includes(companyLower))
    reasons.push(`invalid company: "${job.company}"`);
  if (INVALID_VALUES.includes(titleLower))
    reasons.push(`invalid title: "${job.positionTitle}"`);

  return { valid: reasons.length === 0, reasons };
}

export function mapToAirtableRecord(
  job: ProcessedJob,
): Record<string, unknown> {
  return {
    "Position Title": job.positionTitle,
    Date: (job.datePosted || "").split("T")[0],
    "Apply Link": job.applyLink || "",
    "Work Model": job.workModel || "Onsite",
    Location: job.location || "Not specified",
    Company: job.company,
    ...(job.tags?.length ? { Tags: job.tags } : {}),
    Industry: job.industry || "Software Engineering",
    Salary: job.salary || "Not listed",
    "Job Description": (job.jobDescription || "").slice(0, 100000),
    Qualifications: job.qualifications || "",
    ...(job.jobBoard ? { JobBoard: job.jobBoard } : {}),
    "H1B Sponsored": job.h1bSponsored ?? false,
    "Is New Grad": job.isNewGrad ?? false,
    "Is Internship": job.isInternship ?? false,
  };
}

export interface AirtableCredentials {
  pat: string;
  baseId: string;
  tableName: string;
}

export function getAirtableTable(creds: AirtableCredentials) {
  const base = new Airtable({ apiKey: creds.pat }).base(creds.baseId);
  return base(creds.tableName);
}

export interface UpsertResult {
  created: SyncedJob[];
  failed: Array<{ job: ProcessedJob; error: string }>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function upsertJobs(
  jobs: ProcessedJob[],
  creds: AirtableCredentials,
  opts: { batchDelayMs?: number } = {},
): Promise<UpsertResult> {
  const table = getAirtableTable(creds);
  const created: SyncedJob[] = [];
  const failed: UpsertResult["failed"] = [];
  const delay = opts.batchDelayMs ?? 250;

  for (let i = 0; i < jobs.length; i += 10) {
    const batch = jobs.slice(i, i + 10);
    const records = batch.map((job) => ({ fields: mapToAirtableRecord(job) }));

    try {
      const res = await (table as unknown as {
        create: (
          r: typeof records,
          o: { typecast: boolean },
        ) => Promise<Array<{ id: string }>>;
      }).create(records, { typecast: true });

      res.forEach((rec, j) => {
        const batchJob = batch[j];
        if (batchJob) {
          created.push({
            ...batchJob,
            airtableRecordId: rec.id,
            syncedToAirtable: true,
          });
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      for (const job of batch) failed.push({ job, error: msg });
    }

    if (i + 10 < jobs.length) await sleep(delay);
  }

  return { created, failed };
}
