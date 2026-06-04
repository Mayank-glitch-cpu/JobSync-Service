import { scrapeJobDetails } from "../lib/job-detail-scraper.js";
import type { RawJob } from "../lib/types.js";
import { errorResult, textResult, type ToolDefinition } from "./index.js";

export const scrapeJobDetailsTool: ToolDefinition = {
  name: "scrape_job_details",
  description:
    "Fetch full job details — jobDescription, salary, and datePosted — for a batch of jobs BEFORE upserting to Airtable. " +
    "For Greenhouse jobs (source='greenhouse') calls the individual job API (/v1/boards/{slug}/jobs/{id}?content=true). " +
    "For Lever jobs (source='lever') calls the individual posting API (/v0/postings/{slug}/{id}). " +
    "For Ashby, Workday, and all other portals fetches the applyLink HTML and extracts the JSON-LD JobPosting block " +
    "(datePosted, baseSalary, description), falling back to regex salary patterns and page-text extraction. " +
    "datePosted is ALWAYS non-null on return — falls back to today's date when not found, " +
    "so that airtable_upsert_job validation never rejects a job for a missing date. " +
    "MANDATORY: call this after ANY fetch_*_jobs tool and BEFORE airtable_upsert_job. " +
    "Merge the returned fields back onto each job object (jobDescription, salary, datePosted) " +
    "before passing the enriched array to airtable_upsert_job. ⚖ [Model hint: sonnet]",
  recommendedModel: "sonnet",
  inputSchema: {
    type: "object",
    properties: {
      jobs: {
        type: "array",
        description:
          "Jobs to enrich. Each must have at least `id`. Include `applyLink` and `rawFields.source` " +
          "so the scraper can choose the right strategy (greenhouse/lever API vs generic HTML).",
        maxItems: 50,
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Stable job id (e.g. gh:stripe:12345 or lever:netflix:uuid)." },
            positionTitle: { type: "string" },
            company: { type: "string" },
            location: { type: ["string", "null"] },
            applyLink: { type: ["string", "null"], description: "Job page URL — required for non-Greenhouse/Lever portals." },
            datePosted: { type: ["string", "null"], description: "Existing date if known; scraper will overwrite with a more precise value if found." },
            salary: { type: ["string", "null"], description: "Existing salary if known." },
            rawFields: {
              type: "object",
              description: "Pass rawFields from the fetcher (must include source: 'greenhouse'|'lever'|'ashby'|'workday').",
              additionalProperties: true,
            },
          },
          required: ["id"],
          additionalProperties: true,
        },
      },
    },
    required: ["jobs"],
    additionalProperties: false,
  },
  handler: async (args) => {
    try {
      const rawJobs = (args.jobs as RawJob[]) ?? [];
      if (rawJobs.length === 0) return errorResult("jobs array is empty.");
      if (rawJobs.length > 50) return errorResult("Batch too large — split into chunks of ≤50.");

      const results = await scrapeJobDetails(rawJobs);

      const total = results.length;
      const succeeded = results.filter((r) => r.scrapeStatus === "success").length;
      const withDescription = results.filter((r) => r.jobDescription !== null).length;
      const withSalary = results.filter((r) => r.salary !== null).length;
      const withExplicitDate = results.filter(
        (r) => r.datePosted !== new Date().toISOString().split("T")[0],
      ).length;

      return textResult({
        total,
        succeeded,
        failed: total - succeeded,
        withDescription,
        withSalary,
        withExplicitDate,
        withDateFallback: total - withExplicitDate,
        results,
      });
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
};
