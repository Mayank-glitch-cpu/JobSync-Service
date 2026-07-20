// HTTP-level contract check for the Mutu integration: exercises handleMutuApi
// on a real server the way Mutu's backend would call it after its own
// /upload-resume route parses a resume (ai_profile_extraction_service).

import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleMutuApi } from "./mutu.js";
import { resetMutuDbForTests } from "../lib/mutu/db.js";

let dir: string;
let server: Server;
let base: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "mutu-e2e-"));
  process.env.JOBSYNC_MUTU_DB = join(dir, "mutu.db");
  process.env.JOBSYNC_MUTU_PARSER = "stub";
  resetMutuDbForTests();
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!(await handleMutuApi(req, res, url))) {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  delete process.env.JOBSYNC_MUTU_DB;
  delete process.env.JOBSYNC_MUTU_PARSER;
  resetMutuDbForTests();
  rmSync(dir, { recursive: true, force: true });
});

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// The canonical 23-field record (what Mutu must map its ResumeParseResponse into).
const CANONICAL = {
  first_name: "Jane",
  last_name: "Doe",
  date_of_birth: null,
  email: "jane@example.com",
  phone: "+1-555-0100",
  desired_position: "ML Engineer",
  about: null,
  job_experience: 4,
  job_expectations: null,
  min_salary: 120000,
  max_salary: 160000,
  ready_to_relocation: true,
  work_modes: ["remote"],
  employment_types: ["full-time"],
  employment_durations: [],
  hobbies: null,
  address: { country_name: "USA", region_name: "AZ" },
  skills: [
    { skill_name: "Python", level: null },
    { skill_name: "PyTorch", level: 3 },
  ],
  experiences: [],
  languages: [],
  educations: [],
  certificates: [],
  projects: [],
};

// A plausible ResumeParseResponse from Mutu's ai_profile_extraction_service —
// its own field names, NOT the 23-field record.
const MUTU_NATIVE_SHAPE = {
  personal_info: { full_name: "Jane Doe", email: "jane@example.com", phone: "+1-555-0100" },
  summary: "ML engineer with 4 years of experience.",
  skills: ["Python", "PyTorch", "SQL"],
  work_experience: [{ company: "Acme", title: "ML Engineer", start: "2022", end: "present" }],
  education: [{ school: "ASU", degree: "MS CS" }],
  confidence_score: 0.92,
};

describe("Mutu → JobSync resume ingestion over HTTP", () => {
  let userId: string;

  it("upserts the user (demographics) and returns a userId", async () => {
    const res = await post("/api/mutu/users", {
      email: "jane@example.com",
      firstName: "Jane",
      lastName: "Doe",
      country: "USA",
    });
    expect(res.status).toBe(200);
    const { user } = (await res.json()) as { user: { userId: string } };
    userId = user.userId;
    expect(userId).toBeTruthy();
  });

  it("accepts a pre-parsed 23-field record and echoes it for the preview screen", async () => {
    const res = await post(`/api/mutu/users/${userId}/resume`, {
      resume: CANONICAL,
      parserModel: "claude-sonnet-5",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      parserMode: string;
      resume: { first_name: string | null; skills: unknown[] };
    };
    expect(body.parserMode).toBe("pre-parsed");
    expect(body.resume.first_name).toBe("Jane");
    expect(body.resume.skills).toHaveLength(2);
  });

  it("rejects a Mutu-native ResumeParseResponse shape instead of silently storing an empty record", async () => {
    const res = await post(`/api/mutu/users/${userId}/resume`, {
      resume: MUTU_NATIVE_SHAPE,
      parserModel: "claude-sonnet-5",
    });
    // Guardrail: a payload whose identity/skill fields all normalize to null
    // means the caller sent the wrong schema — fail loudly, don't store junk.
    expect(res.status).toBe(422);
  });

  it("404s resume upload for an unknown user", async () => {
    const res = await post("/api/mutu/users/nope/resume", { resume: CANONICAL });
    expect(res.status).toBe(404);
  });
});
