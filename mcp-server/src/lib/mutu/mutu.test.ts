// Tests for the Mutu integration: relational store round-trips, 23-field schema
// normalization, and the stub parser contract.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeParsedResume } from "./schema.js";
import { parseResumeUpload } from "./parser-client.js";
import {
  getResume,
  getUser,
  ingestJobs,
  latestRoleSynthRun,
  listResumes,
  listUsers,
  queryJobs,
  resetMutuDbForTests,
  saveResume,
  saveRoleSynthRun,
  upsertUser,
} from "./db.js";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mutu-test-"));
  process.env.JOBSYNC_MUTU_DB = join(dir, "mutu.db");
  process.env.JOBSYNC_MUTU_PARSER = "stub";
  resetMutuDbForTests();
});

afterAll(() => {
  delete process.env.JOBSYNC_MUTU_DB;
  delete process.env.JOBSYNC_MUTU_PARSER;
  resetMutuDbForTests();
  rmSync(dir, { recursive: true, force: true });
});

const SAMPLE_RESUME = {
  first_name: "Jane",
  last_name: "Doe",
  date_of_birth: null,
  email: "jane@example.com",
  phone: "+1-555-0100",
  desired_position: "Android Developer",
  about: null,
  job_experience: null,
  job_expectations: null,
  min_salary: null,
  max_salary: null,
  ready_to_relocation: false,
  work_modes: [],
  employment_types: [],
  employment_durations: [],
  hobbies: null,
  address: { country_name: "Uzbekistan", region_name: "Tashkent" },
  skills: [
    { skill_name: "Android Development", level: null },
    { skill_name: "Kotlin", level: null },
  ],
  experiences: [],
  languages: [{ language_name: "English", level: 2 }],
  educations: [],
  certificates: [],
  projects: [],
};

describe("schema normalization", () => {
  it("accepts the canonical 23-field record", () => {
    const parsed = normalizeParsedResume(SAMPLE_RESUME);
    expect(parsed.first_name).toBe("Jane");
    expect(parsed.skills).toHaveLength(2);
  });

  it("nulls malformed scalar fields instead of failing the parse", () => {
    const parsed = normalizeParsedResume({ ...SAMPLE_RESUME, min_salary: "not-a-number", work_modes: "remote" });
    expect(parsed.min_salary).toBeNull();
    expect(parsed.work_modes).toEqual([]);
  });

  it("rejects non-object payloads", () => {
    expect(() => normalizeParsedResume("garbage")).toThrow();
  });

  it("normalizes canonical certificate items and never fails the push on malformed ones", () => {
    const parsed = normalizeParsedResume({
      ...SAMPLE_RESUME,
      certificates: [
        {
          certificate_name: "AWS Solutions Architect",
          certificate_programme: "Associate",
          issuing_date: "2024-03",
          expiring_date: null,
        },
      ],
    });
    expect(parsed.certificates).toEqual([
      {
        certificate_name: "AWS Solutions Architect",
        certificate_programme: "Associate",
        issuing_date: "2024-03",
        expiring_date: null,
      },
    ]);

    // A wrong-shape guess degrades (unknown keys stripped, fields null) — no 422.
    const wrongShape = normalizeParsedResume({
      ...SAMPLE_RESUME,
      certificates: [{ name: "CKA", issuer: "CNCF" }],
    });
    expect(wrongShape.certificates).toEqual([
      {
        certificate_name: null,
        certificate_programme: null,
        issuing_date: null,
        expiring_date: null,
      },
    ]);
  });
});

describe("relational store", () => {
  it("upserts users by email and round-trips demographics", async () => {
    const created = await upsertUser({
      email: "Jane@Example.com",
      firstName: "Jane",
      country: "USA",
      workAuthorization: "F1-OPT",
      github: "https://github.com/jane",
    });
    expect(created.email).toBe("jane@example.com");

    const updated = await upsertUser({ email: "jane@example.com", linkedin: "https://linkedin.com/in/jane" });
    expect(updated.userId).toBe(created.userId); // same row, keyed by email
    expect(updated.github).toBe("https://github.com/jane"); // COALESCE keeps prior values
    expect(updated.linkedin).toBe("https://linkedin.com/in/jane");
    expect(await getUser(created.userId)).not.toBeNull();
    expect(await listUsers()).toHaveLength(1);
  });

  it("stores parsed resumes latest-wins with a skills index", async () => {
    const user = await upsertUser({ email: "jane@example.com" });
    const parsed = normalizeParsedResume(SAMPLE_RESUME);
    await saveResume(user.userId, parsed, "test-model");
    const again = await saveResume(user.userId, parsed, "test-model-2");

    const stored = await getResume(user.userId);
    expect(stored?.resumeId).toBe(again.resumeId); // old row replaced
    expect(stored?.parsed.desired_position).toBe("Android Developer");
    expect(await listResumes()).toHaveLength(1);
  });

  it("rejects resumes for unknown users (FK integrity)", async () => {
    const parsed = normalizeParsedResume(SAMPLE_RESUME);
    await expect(saveResume("no-such-user", parsed, "m")).rejects.toThrow(/unknown user/);
  });

  it("ingests jobs with dedup and supports filtered retrieval", async () => {
    const jobs = [
      { company: "Acme", positionTitle: "Android Developer", applyLink: "https://a.co/1", location: "Austin, TX, USA", tags: ["Kotlin"] },
      { company: "Beta", positionTitle: "ML Engineer", applyLink: "https://b.co/2", location: "Berlin, Germany" },
    ];
    expect(await ingestJobs(jobs)).toBe(2);
    expect(await ingestJobs(jobs)).toBe(0); // dedup on url hash

    const android = await queryJobs({ role: "android" });
    expect(android).toHaveLength(1);
    expect(android[0]?.company).toBe("Acme");

    const bySkill = await queryJobs({ skills: ["Kotlin"] });
    expect(bySkill.map((j) => j.company)).toContain("Acme");

    const inUs = await queryJobs({ country: "USA" });
    expect(inUs.map((j) => j.company)).toContain("Acme");
  });

  it("persists role-synthesis runs", async () => {
    await saveRoleSynthRun({
      userCount: 1,
      resumeCount: 1,
      roles: [{ role: "Android Developer", rationale: "test", demand_signals: ["Kotlin"] }],
      model: "test",
    });
    const latest = await latestRoleSynthRun();
    expect(latest?.roles[0]?.role).toBe("Android Developer");
  });
});

describe("stub parser", () => {
  it("returns a valid 23-field record without a remote worker", async () => {
    const { parsed, parserModel } = await parseResumeUpload({
      filename: "jane_doe.pdf",
      contentBase64: Buffer.from("%PDF-1.4 fake").toString("base64"),
    });
    expect(parserModel).toBe("stub");
    expect(parsed.first_name).toBe("jane");
    expect(Object.keys(parsed)).toHaveLength(23);
  });

  it("rejects unsupported file types and empty uploads", async () => {
    await expect(parseResumeUpload({ filename: "resume.exe", contentBase64: "aGk=" })).rejects.toThrow(/Unsupported/);
    await expect(parseResumeUpload({ filename: "resume.pdf", contentBase64: "" })).rejects.toThrow(/Empty/);
  });
});
