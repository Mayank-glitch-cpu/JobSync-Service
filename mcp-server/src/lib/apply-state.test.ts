import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// browser-apply.ts captures STATE_DIR = join(homedir(), ".jobsync") at module
// load. The real ~/.jobsync/apply-state.json exists on this machine, so we MUST
// NOT let the suite read or overwrite it. Redirect homedir() to a throwaway temp
// directory BEFORE importing the module. vi.mock is hoisted above the import, so
// the module sees the fake home from the very first top-level evaluation.
//
// NOTE: tmpdir() is left untouched (screenshotDir uses it) — only homedir is
// faked, which is the single source of the state file path.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "jobsync-home-"));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual }, homedir: () => FAKE_HOME };
});

// Imported AFTER the mock is registered (vi.mock is hoisted, so this is safe).
const { saveFormState, loadFormState, saveApplyDraft } = await import("./browser-apply.js");
import type { FormState, FillInstruction, PreviewField } from "./browser-apply.js";

const STATE_FILE = join(FAKE_HOME, ".jobsync", "apply-state.json");
const TTL_MS = 7_200_000;

const baseState = (overrides: Partial<FormState> = {}): FormState => ({
  url: "https://jobs.ashbyhq.com/acme/role/application",
  originalUrl: "https://jobs.ashbyhq.com/acme/role",
  pageTitle: "Apply — Acme",
  atsHint: "ashby",
  fields: [
    { selector: "#name", label: "Name", type: "text", placeholder: "", required: true, options: [] },
  ],
  timestamp: Date.now(),
  ...overrides,
});

beforeEach(() => {
  // Start each test from a clean slate so prior writes can't leak in.
  rmSync(STATE_FILE, { force: true });
});

afterAll(() => {
  // Tear down the throwaway home entirely; never touch the user's real ~/.jobsync.
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

// Guard rail: the faked home must NOT be the user's real home. If this ever
// fails, every test below could be writing to the real state file — abort loudly.
describe("test isolation guard", () => {
  it("redirects state to a throwaway temp home, not the real ~/.jobsync", () => {
    expect(STATE_FILE.startsWith(tmpdir())).toBe(true);
    expect(STATE_FILE).not.toContain("OneDrive");
  });
});

// ─── saveFormState / loadFormState round-trip ──────────────────────────────

describe("saveFormState / loadFormState", () => {
  it("round-trips a full FormState", () => {
    const state = baseState();
    saveFormState(state);
    const loaded = loadFormState();
    expect(loaded).toEqual(state);
  });

  it("persists the state to disk as JSON", () => {
    saveFormState(baseState({ atsHint: "greenhouse" }));
    expect(existsSync(STATE_FILE)).toBe(true);
    const onDisk = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    expect(onDisk.atsHint).toBe("greenhouse");
  });

  it("returns null when no state file exists", () => {
    expect(loadFormState()).toBeNull();
  });

  it("returns null when the state file is corrupt JSON", () => {
    saveFormState(baseState());
    // Corrupt the file out-of-band, then confirm load fails closed (null, no throw).
    writeFileSync(STATE_FILE, "{ not valid json", "utf-8");
    expect(loadFormState()).toBeNull();
  });

  it("preserves draftInstructions and draftPreview through a round-trip", () => {
    const draftInstructions: FillInstruction[] = [
      { selector: "#name", value: "Prisha Nag", type: "text", label: "Name" },
    ];
    const draftPreview: PreviewField[] = [{ field: "Name", value: "Prisha Nag", type: "text" }];
    saveFormState(baseState({ draftInstructions, draftPreview }));
    const loaded = loadFormState();
    expect(loaded?.draftInstructions).toEqual(draftInstructions);
    expect(loaded?.draftPreview).toEqual(draftPreview);
  });
});

// ─── TTL expiry ────────────────────────────────────────────────────────────

describe("loadFormState TTL", () => {
  it("returns a state saved just now (within TTL)", () => {
    saveFormState(baseState({ timestamp: Date.now() }));
    expect(loadFormState()).not.toBeNull();
  });

  it("returns null for a state older than the 2-hour TTL", () => {
    saveFormState(baseState({ timestamp: Date.now() - TTL_MS - 1000 }));
    expect(loadFormState()).toBeNull();
  });

  it("returns a state exactly at the TTL boundary (not yet expired)", () => {
    // TTL check is strict `>` : a delta of exactly TTL is still valid.
    const fixedNow = 1_900_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(fixedNow);
    saveFormState(baseState({ timestamp: fixedNow - TTL_MS }));
    expect(loadFormState()).not.toBeNull();
    vi.restoreAllMocks();
  });
});

// ─── saveApplyDraft ──────────────────────────────────────────────────────────

describe("saveApplyDraft", () => {
  const instructions: FillInstruction[] = [
    { selector: "#name", value: "Prisha Nag", type: "text", label: "Name" },
    { selector: "#email", value: "p@x.com", type: "email", label: "Email" },
  ];
  const preview: PreviewField[] = [
    { field: "Name", value: "Prisha Nag" },
    { field: "Email", value: "p@x.com" },
  ];

  it("writes the draft instructions and preview and they round-trip", () => {
    saveApplyDraft(instructions, preview, "https://jobs.ashbyhq.com/acme/role");
    const loaded = loadFormState();
    expect(loaded?.draftInstructions).toEqual(instructions);
    expect(loaded?.draftPreview).toEqual(preview);
  });

  it("derives atsHint from applyLink when there is no existing state", () => {
    const state = saveApplyDraft(instructions, preview, "https://boards.greenhouse.io/acme/jobs/1");
    expect(state.atsHint).toBe("greenhouse");
  });

  it("returns 'unknown' atsHint when applyLink is omitted and no prior state", () => {
    const state = saveApplyDraft(instructions);
    expect(state.atsHint).toBe("unknown");
    expect(state.draftPreview).toEqual([]);
  });

  it("preserves url/atsHint/fields from prior inspected state (only updates the draft)", () => {
    // inspectForm-style state already on disk: keep its url, atsHint and fields.
    const prior = baseState({
      url: "https://jobs.ashbyhq.com/acme/role/application",
      atsHint: "ashby",
      fields: [
        { selector: "#name", label: "Name", type: "text", placeholder: "", required: true, options: [] },
        { selector: "#email", label: "Email", type: "email", placeholder: "", required: true, options: [] },
      ],
    });
    saveFormState(prior);

    // saveApplyDraft passes a different applyLink, but existing state wins.
    const state = saveApplyDraft(instructions, preview, "https://boards.greenhouse.io/other");
    expect(state.url).toBe(prior.url);
    expect(state.atsHint).toBe("ashby");
    expect(state.fields).toEqual(prior.fields);
    expect(state.draftInstructions).toEqual(instructions);

    const loaded = loadFormState();
    expect(loaded?.atsHint).toBe("ashby");
    expect(loaded?.draftInstructions).toEqual(instructions);
  });

  it("refreshes the timestamp so a reloaded draft is within TTL", () => {
    saveApplyDraft(instructions, preview, "https://jobs.ashbyhq.com/acme/role");
    const loaded = loadFormState();
    expect(loaded).not.toBeNull();
    expect(Date.now() - (loaded?.timestamp ?? 0)).toBeLessThan(5000);
  });
});
