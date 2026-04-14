import {
  DEFAULT_EXCLUDE_KEYWORDS,
  DEFAULT_INCLUDE_KEYWORDS,
  isLikelyNonUSLocation,
  passesTitleFilter,
  type FilterableJob,
} from "../lib/filter.js";
import { detectIndustry, INDUSTRY_LIST } from "../lib/industries.js";
import { detectJobBoard, detectTags, isKnownH1bSponsor } from "../lib/tags.js";
import type { ScrapedJob } from "../lib/types.js";
import { textResult, type ToolDefinition } from "./index.js";

export const filterUsLocationTool: ToolDefinition = {
  name: "filter_us_location",
  description:
    "Decide whether a location string looks non-US. Returns { likelyNonUS: boolean }. Use before deciding to keep or discard a job posting when usOnly mode is active.",
  inputSchema: {
    type: "object",
    properties: {
      location: { type: "string", description: "Raw location string from the job posting." },
    },
    required: ["location"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const loc = String(args.location ?? "");
    return textResult({ location: loc, likelyNonUS: isLikelyNonUSLocation(loc) });
  },
};

export const filterTitleKeywordsTool: ToolDefinition = {
  name: "filter_title_keywords",
  description:
    "Cheap pre-filter for a job title. Rejects excluded seniority/role keywords and requires at least one include keyword. Optionally enforces US-only location. Defaults are tuned for new-grad tech roles.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      location: { type: "string" },
      include: {
        type: "array",
        items: { type: "string" },
        description: `Override include keywords. Defaults: ${DEFAULT_INCLUDE_KEYWORDS.join(", ")}.`,
      },
      exclude: {
        type: "array",
        items: { type: "string" },
        description: `Override exclude keywords. Defaults: ${DEFAULT_EXCLUDE_KEYWORDS.join(", ")}.`,
      },
      usOnly: { type: "boolean", description: "Default true." },
    },
    required: ["title"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const job: FilterableJob = {
      title: String(args.title ?? ""),
      location: args.location ? String(args.location) : null,
    };
    const passes = passesTitleFilter(job, {
      include: args.include as string[] | undefined,
      exclude: args.exclude as string[] | undefined,
      usOnly: args.usOnly as boolean | undefined,
    });
    return textResult({ passes, title: job.title, location: job.location });
  },
};

export const detectIndustryTagsTool: ToolDefinition = {
  name: "detect_industry_tags",
  description:
    "Deterministic classifier. Given a job's company name and title, returns the matched industry (from a fixed taxonomy), the company tier tags (FAANG+, Quant, Unicorn, YC, Crypto/Web3, Fortune 500), known-H1B-sponsor flag, and detected job board from the apply URL.",
  inputSchema: {
    type: "object",
    properties: {
      company: { type: "string" },
      positionTitle: { type: "string" },
      applyLink: { type: ["string", "null"] },
      jobDescription: { type: ["string", "null"] },
    },
    required: ["company", "positionTitle"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const company = String(args.company ?? "");
    const title = String(args.positionTitle ?? "");
    const applyLink = (args.applyLink ?? null) as string | null;
    const jobDescription = (args.jobDescription ?? null) as string | null;

    return textResult({
      industry: detectIndustry(title) ?? detectIndustry(jobDescription ?? "") ?? null,
      tags: detectTags({ company }),
      h1bSponsor: isKnownH1bSponsor(company),
      jobBoard: detectJobBoard(applyLink, jobDescription),
      industryOptions: INDUSTRY_LIST,
    });
  },
};

interface BatchJob {
  id?: string;
  positionTitle: string;
  company: string;
  location?: string | null;
  applyLink?: string | null;
  jobDescription?: string | null;
}

export const classifyJobBatchTool: ToolDefinition = {
  name: "classify_job_batch",
  description:
    "Composite classifier over an array of jobs. Runs US-location filter, title-keyword filter, and industry/tag/H1B/job-board detection in one call. Returns a parallel array of verdicts. Use this after web_fetch to process a page of postings efficiently.",
  inputSchema: {
    type: "object",
    properties: {
      jobs: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            positionTitle: { type: "string" },
            company: { type: "string" },
            location: { type: ["string", "null"] },
            applyLink: { type: ["string", "null"] },
            jobDescription: { type: ["string", "null"] },
          },
          required: ["positionTitle", "company"],
          additionalProperties: true,
        },
      },
      include: { type: "array", items: { type: "string" } },
      exclude: { type: "array", items: { type: "string" } },
      usOnly: { type: "boolean" },
    },
    required: ["jobs"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const jobs = (args.jobs as BatchJob[]) ?? [];
    const include = args.include as string[] | undefined;
    const exclude = args.exclude as string[] | undefined;
    const usOnly = (args.usOnly as boolean | undefined) ?? true;

    const results = jobs.map((job) => {
      const passesTitle = passesTitleFilter(
        { title: job.positionTitle, location: job.location ?? null },
        { include, exclude, usOnly },
      );
      const likelyNonUS = job.location ? isLikelyNonUSLocation(job.location) : false;
      const industry =
        detectIndustry(job.positionTitle) ??
        detectIndustry(job.jobDescription ?? "") ??
        null;
      return {
        // ── original fields (pass-through so nothing is dropped before upsert) ──
        id: job.id ?? null,
        positionTitle: job.positionTitle,
        company: job.company,
        location: job.location ?? null,
        applyLink: job.applyLink ?? null,
        jobDescription: job.jobDescription ?? null,
        // ── classification enrichment ──
        passes: passesTitle,
        likelyNonUS,
        industry,
        tags: detectTags({ company: job.company }),
        h1bSponsor: isKnownH1bSponsor(job.company),
        jobBoard: detectJobBoard(job.applyLink ?? null, job.jobDescription ?? null),
      };
    });

    const accepted = results.filter((r) => r.passes).length;
    return textResult({ total: results.length, accepted, rejected: results.length - accepted, results });
  },
};

export function normalizeBatchJobToScraped(job: BatchJob): ScrapedJob {
  return {
    id: job.id ?? "",
    positionTitle: job.positionTitle,
    company: job.company,
    location: job.location ?? null,
    applyLink: job.applyLink ?? null,
    datePosted: null,
    salary: null,
    rawFields: {},
    jobDescription: job.jobDescription ?? null,
    scrapeStatus: "success",
  };
}
