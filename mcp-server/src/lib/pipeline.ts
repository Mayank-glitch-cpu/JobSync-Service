import { join } from "node:path";
import { CONFIG_DIR } from "../config.js";
import { getStore } from "./store/index.js";

const NS = "pipeline";
/** Default scope for the single-user (local/stdio) path. Multi-user callers pass a uid. */
const DEFAULT_SCOPE = "default";

export type ApplicationStatus =
  | "pending"
  | "applied"
  | "interviewing"
  | "offer"
  | "rejected"
  | "withdrawn";

export interface PipelineEntry {
  id: string;
  positionTitle: string;
  company: string;
  location: string;
  applyLink: string;
  datePosted: string;
  industry: string;
  tags: string;      // comma-separated
  fitScore: string;  // "8" or "" if unscored
  status: ApplicationStatus;
  appliedAt: string; // YYYY-MM-DD or ""
  updatedAt: string; // YYYY-MM-DD
  notes: string;
}

const HEADERS: (keyof PipelineEntry)[] = [
  "id", "positionTitle", "company", "location", "applyLink",
  "datePosted", "industry", "tags", "fitScore", "status",
  "appliedAt", "updatedAt", "notes",
];

const VALID_STATUSES = new Set<string>([
  "pending", "applied", "interviewing", "offer", "rejected", "withdrawn",
]);

/** Logical location label (the local file path) — for display/diagnostics only. */
export function getPipelinePath(): string {
  return join(CONFIG_DIR, "pipeline.tsv");
}

function escape(value: string): string {
  return (value ?? "").replace(/[\t\n\r]/g, " ");
}

export async function readPipeline(scope: string = DEFAULT_SCOPE): Promise<PipelineEntry[]> {
  const raw = await (await getStore()).docs.readDoc(NS, scope);
  if (!raw) return [];

  const lines = raw.split("\n").filter(Boolean);
  if (lines.length <= 1) return [];

  return lines.slice(1).map((line) => {
    const cols = line.split("\t");
    const obj: Record<string, string> = {};
    HEADERS.forEach((key, i) => { obj[key] = cols[i] ?? ""; });
    return obj as unknown as PipelineEntry;
  });
}

export async function writePipeline(entries: PipelineEntry[], scope: string = DEFAULT_SCOPE): Promise<void> {
  const header = HEADERS.join("\t");
  const rows = entries.map((e) =>
    HEADERS.map((k) => escape((e as unknown as Record<string, string>)[k] ?? "")).join("\t")
  );
  const body = [header, ...rows].join("\n") + "\n";
  await (await getStore()).docs.writeDoc(NS, scope, body);
}

export async function upsertPipelineEntries(
  incoming: Array<Partial<PipelineEntry> & { positionTitle: string; company: string; applyLink: string }>,
  scope: string = DEFAULT_SCOPE,
): Promise<{ added: number; updated: number }> {
  const existing = await readPipeline(scope);
  const byId = new Map(existing.map((e) => [e.id, e]));
  const byLink = new Map(existing.map((e) => [e.applyLink, e]));

  let added = 0;
  let updated = 0;
  const now = new Date().toISOString().slice(0, 10);

  for (const job of incoming) {
    const hit =
      (job.id && byId.get(job.id)) ||
      (job.applyLink && byLink.get(job.applyLink));

    if (hit) {
      // Preserve status / appliedAt / notes; refresh metadata fields
      hit.positionTitle = job.positionTitle ?? hit.positionTitle;
      hit.company = job.company ?? hit.company;
      hit.location = job.location ?? hit.location;
      hit.datePosted = job.datePosted ?? hit.datePosted;
      hit.industry = job.industry ?? hit.industry;
      hit.tags = job.tags ?? hit.tags;
      hit.fitScore = job.fitScore ?? hit.fitScore;
      hit.updatedAt = now;
      updated++;
    } else {
      const id = job.id ?? Math.random().toString(36).slice(2, 10);
      const entry: PipelineEntry = {
        id,
        positionTitle: job.positionTitle,
        company: job.company,
        location: job.location ?? "",
        applyLink: job.applyLink,
        datePosted: job.datePosted ?? "",
        industry: job.industry ?? "",
        tags: job.tags ?? "",
        fitScore: job.fitScore ?? "",
        status: "pending",
        appliedAt: "",
        updatedAt: now,
        notes: "",
      };
      byId.set(id, entry);
      byLink.set(entry.applyLink, entry);
      added++;
    }
  }

  await writePipeline(Array.from(byId.values()), scope);
  return { added, updated };
}

export async function markApplied(
  applyLinks: string[],
  scope: string = DEFAULT_SCOPE,
): Promise<{ matched: number; notFound: string[] }> {
  const entries = await readPipeline(scope);
  const linkSet = new Set(applyLinks.map((l) => l.trim()));
  const now = new Date().toISOString().slice(0, 10);
  let matched = 0;

  for (const entry of entries) {
    if (linkSet.has(entry.applyLink)) {
      entry.status = "applied";
      if (!entry.appliedAt) entry.appliedAt = now;
      entry.updatedAt = now;
      matched++;
    }
  }

  await writePipeline(entries, scope);
  const notFound = applyLinks.filter((l) => !entries.some((e) => e.applyLink === l));
  return { matched, notFound };
}

export async function updateStatuses(
  updates: Array<{ applyLink?: string; id?: string; status: ApplicationStatus; notes?: string }>,
  scope: string = DEFAULT_SCOPE,
): Promise<{ matched: number; invalid: string[] }> {
  const entries = await readPipeline(scope);
  const now = new Date().toISOString().slice(0, 10);
  let matched = 0;
  const invalid: string[] = [];

  for (const upd of updates) {
    if (!VALID_STATUSES.has(upd.status)) {
      invalid.push(upd.status);
      continue;
    }
    const entry = entries.find(
      (e) =>
        (upd.id && e.id === upd.id) ||
        (upd.applyLink && e.applyLink === upd.applyLink)
    );
    if (!entry) continue;

    entry.status = upd.status;
    entry.updatedAt = now;
    if (upd.status === "applied" && !entry.appliedAt) entry.appliedAt = now;
    if (upd.notes !== undefined) entry.notes = upd.notes;
    matched++;
  }

  await writePipeline(entries, scope);
  return { matched, invalid };
}

export async function getPipelineGrouped(
  statusFilter?: ApplicationStatus[],
  scope: string = DEFAULT_SCOPE,
): Promise<{ summary: Record<string, number>; byStatus: Record<string, PipelineEntry[]> }> {
  const all = await readPipeline(scope);
  const entries = statusFilter
    ? all.filter((e) => statusFilter.includes(e.status))
    : all;

  const byStatus: Record<string, PipelineEntry[]> = {};
  for (const e of entries) {
    (byStatus[e.status] ??= []).push(e);
  }

  const summary: Record<string, number> = { total: entries.length };
  for (const s of ["pending", "applied", "interviewing", "offer", "rejected", "withdrawn"] as const) {
    summary[s] = byStatus[s]?.length ?? 0;
  }

  return { summary, byStatus };
}
