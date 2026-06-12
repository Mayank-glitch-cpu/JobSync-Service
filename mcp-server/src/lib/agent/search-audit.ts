// Post-run audit for the Search agent.
//
// The Search agent is a model-driven loop: nothing in code enforces that the jobs
// it lands in the pipeline are actually recent, live, on-target, and real. This
// module re-checks every job the agent upserted during a run and produces an
// AuditReport. It is deliberately the SAME verifier logic we use in the eval
// suite (see docs/agent-architecture-and-evals.md §7) — write it once, run it in
// prod and in evals.
//
// Checks (per job):
//   recency        — datePosted parses and falls within the lookback window
//   liveness       — the apply link still resolves to an open posting
//   titleMatch     — the title matches a target role (only when roles were given)
//   observed       — the applyLink appeared in a tool result the agent saw
//                    (no-fabrication: the agent didn't invent or mutate the link)
//
// liveness is network-bound, so the verifier is injectable for tests.

import { checkJobLinkLive } from "../../tools/link-check-tools.js";
import { now as clockNow } from "../eval/clock.js";

export interface AuditedJob {
  applyLink: string;
  positionTitle: string;
  datePosted?: string;
  company?: string;
}

export interface JobAuditResult {
  applyLink: string;
  positionTitle: string;
  /** true = inside window, false = stale, null = no parseable datePosted. */
  recencyOk: boolean | null;
  /** true = live, false = dead/closed, null = not checked. */
  liveOk: boolean | null;
  /** true = matches a role, false = no match, null = no roles to check against. */
  titleMatchOk: boolean | null;
  /** Did the link show up in a tool result the agent observed? */
  observed: boolean;
  /** Human-readable reasons a check failed (empty when clean). */
  reasons: string[];
}

export interface AuditReport {
  total: number;
  /** Jobs with no failed checks. */
  clean: number;
  /** Jobs with at least one failed check. */
  flagged: number;
  /** Links that failed the no-fabrication check — the most serious finding. */
  fabricated: string[];
  results: JobAuditResult[];
}

export interface AuditOptions {
  lookbackHours: number;
  /** Target roles; when present, every job's title must match one of them. */
  roles?: string[];
  /** Reference "now" — defaults to the wall clock; overridable for evals/tests. */
  now?: Date;
  /** Link verifier — defaults to the production board-specific checker. */
  verifyLink?: (url: string) => Promise<{ active: boolean; reason?: string }>;
}

/** Parse a YYYY-MM-DD (or ISO) datePosted into a Date, or null if unparseable. */
function parseDatePosted(raw: string | undefined): Date | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Accept "YYYY-MM-DD" and full ISO timestamps.
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) return null;
  return new Date(ms);
}

function titleMatchesRole(title: string, roles: string[]): boolean {
  const t = title.toLowerCase();
  return roles.some((r) => {
    const k = r.trim().toLowerCase();
    return k.length > 0 && t.includes(k);
  });
}

/**
 * Audit the jobs a search run landed. `observedText` is the concatenation of all
 * tool-result content the agent saw this run (used for the no-fabrication check).
 */
export async function auditSearchRun(
  jobs: AuditedJob[],
  observedText: string,
  opts: AuditOptions,
): Promise<AuditReport> {
  const now = opts.now ?? clockNow();
  const cutoff = new Date(now.getTime() - opts.lookbackHours * 3_600_000);
  const roles = (opts.roles ?? []).filter((r) => r.trim().length > 0);
  const verify =
    opts.verifyLink ??
    (async (url: string) => {
      const status = await checkJobLinkLive(url);
      return { active: status.active, reason: status.reason };
    });

  const results = await Promise.all(
    jobs.map(async (job): Promise<JobAuditResult> => {
      const reasons: string[] = [];

      // 1. Recency.
      const posted = parseDatePosted(job.datePosted);
      let recencyOk: boolean | null;
      if (posted === null) {
        recencyOk = null;
        reasons.push("datePosted missing or unparseable — recency unverifiable");
      } else if (posted.getTime() >= cutoff.getTime()) {
        recencyOk = true;
      } else {
        recencyOk = false;
        reasons.push(
          `posted ${job.datePosted} is older than the ${opts.lookbackHours}h lookback window`,
        );
      }

      // 2. No-fabrication: the link must have been observed in a tool result.
      const observed = observedText.includes(job.applyLink);
      if (!observed) {
        reasons.push("applyLink never appeared in a tool result — possibly fabricated");
      }

      // 3. Title vs target roles (only when roles were specified).
      let titleMatchOk: boolean | null;
      if (roles.length === 0) {
        titleMatchOk = null;
      } else if (titleMatchesRole(job.positionTitle, roles)) {
        titleMatchOk = true;
      } else {
        titleMatchOk = false;
        reasons.push(`title "${job.positionTitle}" does not match target roles`);
      }

      // 4. Liveness — last because it's the slow, network-bound check.
      let liveOk: boolean | null;
      try {
        const status = await verify(job.applyLink);
        liveOk = status.active;
        if (!status.active) {
          reasons.push(`apply link is not live${status.reason ? `: ${status.reason}` : ""}`);
        }
      } catch (err) {
        liveOk = null;
        reasons.push(`liveness check errored: ${err instanceof Error ? err.message : String(err)}`);
      }

      return {
        applyLink: job.applyLink,
        positionTitle: job.positionTitle,
        recencyOk,
        liveOk,
        titleMatchOk,
        observed,
        reasons,
      };
    }),
  );

  const flagged = results.filter((r) => r.reasons.length > 0).length;
  const fabricated = results.filter((r) => !r.observed).map((r) => r.applyLink);

  return {
    total: results.length,
    clean: results.length - flagged,
    flagged,
    fabricated,
    results,
  };
}

/**
 * Turn the flagged jobs in an audit report into pipeline note annotations
 * (`{ applyLink, note }`) suitable for annotatePipelineEntries. Clean jobs produce
 * no note. The note is prefixed so audit flags are recognizable in the pipeline.
 */
export function auditFlagNotes(report: AuditReport): Array<{ applyLink: string; note: string }> {
  return report.results
    .filter((r) => r.reasons.length > 0)
    .map((r) => ({ applyLink: r.applyLink, note: `⚠ audit: ${r.reasons.join("; ")}` }));
}

/** One-line human summary of an audit report for the progress log. */
export function summarizeAudit(report: AuditReport): string {
  if (report.total === 0) return "Audit: no jobs landed this run.";
  const parts = [`Audit: ${report.clean}/${report.total} jobs clean`];
  if (report.flagged > 0) parts.push(`${report.flagged} flagged`);
  if (report.fabricated.length > 0) parts.push(`${report.fabricated.length} unobserved (possible fabrication)`);
  return parts.join(", ") + ".";
}
