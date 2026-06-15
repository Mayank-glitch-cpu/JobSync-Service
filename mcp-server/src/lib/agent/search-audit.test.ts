import { describe, it, expect, vi } from "vitest";

// Stub the network-bound link checker so the audit module never hits the wire.
// Default: everything is live. Individual tests override via the injectable
// verifyLink option instead, but the import must still resolve.
vi.mock("../../tools/link-check-tools.js", () => ({
  checkJobLinkLive: vi.fn(() => Promise.resolve({ active: true, reason: "ok" })),
}));

import { auditFlagNotes, auditSearchRun, summarizeAudit, type AuditedJob } from "./search-audit.js";

const NOW = new Date("2026-06-10T12:00:00Z");
const liveAll = () => Promise.resolve({ active: true });

function job(overrides: Partial<AuditedJob> = {}): AuditedJob {
  return {
    applyLink: "https://boards.greenhouse.io/acme/jobs/123",
    positionTitle: "Machine Learning Engineer",
    datePosted: "2026-06-09",
    company: "Acme",
    ...overrides,
  };
}

describe("auditSearchRun — recency", () => {
  it("passes a job posted inside the lookback window", async () => {
    const j = job({ datePosted: "2026-06-09" });
    const report = await auditSearchRun([j], j.applyLink, {
      lookbackHours: 48,
      now: NOW,
      verifyLink: liveAll,
    });
    expect(report.results[0]!.recencyOk).toBe(true);
    expect(report.clean).toBe(1);
  });

  it("flags a job older than the lookback window", async () => {
    const j = job({ datePosted: "2026-06-01" });
    const report = await auditSearchRun([j], j.applyLink, {
      lookbackHours: 48,
      now: NOW,
      verifyLink: liveAll,
    });
    expect(report.results[0]!.recencyOk).toBe(false);
    expect(report.flagged).toBe(1);
    expect(report.results[0]!.reasons.join(" ")).toContain("lookback window");
  });

  it("returns null recency when datePosted is missing", async () => {
    const j = job({ datePosted: undefined });
    const report = await auditSearchRun([j], j.applyLink, {
      lookbackHours: 48,
      now: NOW,
      verifyLink: liveAll,
    });
    expect(report.results[0]!.recencyOk).toBeNull();
    expect(report.flagged).toBe(1);
  });
});

describe("auditSearchRun — no-fabrication", () => {
  it("flags a link that never appeared in observed tool output", async () => {
    const j = job();
    const report = await auditSearchRun([j], "totally unrelated tool output", {
      lookbackHours: 48,
      now: NOW,
      verifyLink: liveAll,
    });
    expect(report.results[0]!.observed).toBe(false);
    expect(report.fabricated).toEqual([j.applyLink]);
    expect(report.results[0]!.reasons.join(" ")).toContain("fabricated");
  });

  it("passes a link present in observed output", async () => {
    const j = job();
    const report = await auditSearchRun([j], `found: ${j.applyLink} in board`, {
      lookbackHours: 48,
      now: NOW,
      verifyLink: liveAll,
    });
    expect(report.results[0]!.observed).toBe(true);
    expect(report.fabricated).toEqual([]);
  });
});

describe("auditSearchRun — title match", () => {
  it("skips title check (null) when no roles given", async () => {
    const j = job();
    const report = await auditSearchRun([j], j.applyLink, {
      lookbackHours: 48,
      now: NOW,
      verifyLink: liveAll,
    });
    expect(report.results[0]!.titleMatchOk).toBeNull();
  });

  it("passes a title that matches a target role (case-insensitive)", async () => {
    const j = job({ positionTitle: "Senior Machine Learning Engineer" });
    const report = await auditSearchRun([j], j.applyLink, {
      lookbackHours: 48,
      now: NOW,
      roles: ["machine learning"],
      verifyLink: liveAll,
    });
    expect(report.results[0]!.titleMatchOk).toBe(true);
  });

  it("flags a title that matches no target role", async () => {
    const j = job({ positionTitle: "Account Executive" });
    const report = await auditSearchRun([j], j.applyLink, {
      lookbackHours: 48,
      now: NOW,
      roles: ["machine learning", "data scientist"],
      verifyLink: liveAll,
    });
    expect(report.results[0]!.titleMatchOk).toBe(false);
    expect(report.flagged).toBe(1);
  });
});

describe("auditSearchRun — liveness", () => {
  it("flags a dead link and surfaces the reason", async () => {
    const j = job();
    const report = await auditSearchRun([j], j.applyLink, {
      lookbackHours: 48,
      now: NOW,
      verifyLink: () => Promise.resolve({ active: false, reason: "404 — closed" }),
    });
    expect(report.results[0]!.liveOk).toBe(false);
    expect(report.results[0]!.reasons.join(" ")).toContain("404 — closed");
  });

  it("records null liveness when the verifier throws", async () => {
    const j = job();
    const report = await auditSearchRun([j], j.applyLink, {
      lookbackHours: 48,
      now: NOW,
      verifyLink: () => Promise.reject(new Error("network down")),
    });
    expect(report.results[0]!.liveOk).toBeNull();
    expect(report.results[0]!.reasons.join(" ")).toContain("network down");
  });
});

describe("auditSearchRun — aggregation & summary", () => {
  it("counts clean vs flagged across multiple jobs", async () => {
    const good = job({ applyLink: "https://boards.greenhouse.io/acme/jobs/1" });
    const stale = job({ applyLink: "https://boards.greenhouse.io/acme/jobs/2", datePosted: "2026-01-01" });
    const observed = `${good.applyLink} ${stale.applyLink}`;
    const report = await auditSearchRun([good, stale], observed, {
      lookbackHours: 48,
      now: NOW,
      verifyLink: liveAll,
    });
    expect(report.total).toBe(2);
    expect(report.clean).toBe(1);
    expect(report.flagged).toBe(1);
  });

  it("summarizes an empty run", () => {
    expect(summarizeAudit({ total: 0, clean: 0, flagged: 0, fabricated: [], results: [] })).toContain(
      "no jobs",
    );
  });

  it("auditFlagNotes returns one prefixed note per flagged job, none for clean", async () => {
    const good = job({ applyLink: "https://boards.greenhouse.io/acme/jobs/1" });
    const stale = job({ applyLink: "https://boards.greenhouse.io/acme/jobs/2", datePosted: "2026-01-01" });
    const report = await auditSearchRun([good, stale], `${good.applyLink} ${stale.applyLink}`, {
      lookbackHours: 48,
      now: NOW,
      verifyLink: liveAll,
    });
    const notes = auditFlagNotes(report);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.applyLink).toBe(stale.applyLink);
    expect(notes[0]!.note).toMatch(/^⚠ audit:/);
  });

  it("summarizes flagged + fabricated counts", () => {
    const summary = summarizeAudit({
      total: 3,
      clean: 1,
      flagged: 2,
      fabricated: ["https://x/y"],
      results: [],
    });
    expect(summary).toContain("1/3 jobs clean");
    expect(summary).toContain("2 flagged");
    expect(summary).toContain("possible fabrication");
  });
});
