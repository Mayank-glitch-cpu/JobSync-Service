import { describe, it, expect } from "vitest";
import {
  detectAts,
  normalizeFormUrl,
  looksLikeApplicationForm,
} from "./browser-apply.js";
import type { DetectedField } from "./browser-apply.js";

// Build a DetectedField defaulting placeholder/options/required so the form-shape
// fixtures stay readable.
const field = (
  f: Pick<DetectedField, "selector" | "label" | "type"> & Partial<DetectedField>,
): DetectedField => ({ placeholder: "", required: false, options: [], ...f });

// ─── detectAts ─────────────────────────────────────────────────────────────

describe("detectAts", () => {
  it("detects Greenhouse from boards.greenhouse.io", () => {
    expect(detectAts("https://boards.greenhouse.io/acme/jobs/123")).toBe("greenhouse");
  });

  it("detects Greenhouse from the grnh.se shortener", () => {
    expect(detectAts("https://grnh.se/abc123")).toBe("greenhouse");
  });

  it("detects Lever", () => {
    expect(detectAts("https://jobs.lever.co/acme/abc-def")).toBe("lever");
  });

  it("detects Ashby", () => {
    expect(detectAts("https://jobs.ashbyhq.com/cohere/some-role")).toBe("ashby");
  });

  it("detects Workday from myworkdayjobs.com", () => {
    expect(detectAts("https://acme.wd1.myworkdayjobs.com/careers/job/123")).toBe("workday");
  });

  it("detects Workday from workday.com", () => {
    expect(detectAts("https://acme.workday.com/careers")).toBe("workday");
  });

  it("detects SmartRecruiters", () => {
    expect(detectAts("https://jobs.smartrecruiters.com/acme/123")).toBe("smartrecruiters");
  });

  it("detects Jobvite", () => {
    expect(detectAts("https://jobs.jobvite.com/acme/job/123")).toBe("jobvite");
  });

  it("returns 'unknown' for an unrecognised ATS", () => {
    expect(detectAts("https://careers.example.com/apply/123")).toBe("unknown");
  });

  it("returns 'unknown' for an empty URL", () => {
    expect(detectAts("")).toBe("unknown");
  });
});

// ─── normalizeFormUrl ──────────────────────────────────────────────────────

describe("normalizeFormUrl", () => {
  it("appends /application to a bare Ashby job URL", () => {
    expect(normalizeFormUrl("https://jobs.ashbyhq.com/cohere/role-id", "ashby")).toBe(
      "https://jobs.ashbyhq.com/cohere/role-id/application",
    );
  });

  it("strips a trailing slash before appending /application (no double slash)", () => {
    expect(normalizeFormUrl("https://jobs.ashbyhq.com/cohere/role-id/", "ashby")).toBe(
      "https://jobs.ashbyhq.com/cohere/role-id/application",
    );
  });

  it("does not double-append when /application is already present", () => {
    expect(
      normalizeFormUrl("https://jobs.ashbyhq.com/cohere/role-id/application", "ashby"),
    ).toBe("https://jobs.ashbyhq.com/cohere/role-id/application");
  });

  it("leaves a trailing /application/ untouched", () => {
    expect(
      normalizeFormUrl("https://jobs.ashbyhq.com/cohere/role-id/application/", "ashby"),
    ).toBe("https://jobs.ashbyhq.com/cohere/role-id/application/");
  });

  it("does not rewrite non-Ashby URLs", () => {
    const gh = "https://boards.greenhouse.io/acme/jobs/123";
    expect(normalizeFormUrl(gh, "greenhouse")).toBe(gh);
  });
});

// ─── looksLikeApplicationForm ──────────────────────────────────────────────

describe("looksLikeApplicationForm", () => {
  it("is true once there are 5 or more fields", () => {
    const fields = [
      { selector: "#a", label: "A", type: "text" },
      { selector: "#b", label: "B", type: "text" },
      { selector: "#c", label: "C", type: "text" },
      { selector: "#d", label: "D", type: "text" },
      { selector: "#e", label: "E", type: "text" },
    ].map(field);
    expect(looksLikeApplicationForm(fields)).toBe(true);
  });

  it("is true for a small form with >=2 application signals (name + email)", () => {
    const fields = [
      { selector: "#first", label: "First Name", type: "text" },
      { selector: "#email", label: "Email Address", type: "email" },
    ].map(field);
    expect(looksLikeApplicationForm(fields)).toBe(true);
  });

  it("recognises signals from selector/placeholder, not just label", () => {
    const fields = [
      { selector: "#linkedin_url", label: "", type: "text", placeholder: "Your profile" },
      { selector: "#resume", label: "", type: "file" },
    ].map(field);
    expect(looksLikeApplicationForm(fields)).toBe(true);
  });

  it("is false for a small non-application form (e.g. a search box + filter)", () => {
    const fields = [
      { selector: "#q", label: "Search jobs", type: "text" },
      { selector: "#loc", label: "Filter by team", type: "select" },
    ].map(field);
    expect(looksLikeApplicationForm(fields)).toBe(false);
  });

  it("is false for a single field with only one signal", () => {
    const fields = [{ selector: "#email", label: "Email", type: "email" }].map(field);
    expect(looksLikeApplicationForm(fields)).toBe(false);
  });

  it("is false for an empty field list", () => {
    expect(looksLikeApplicationForm([])).toBe(false);
  });
});
