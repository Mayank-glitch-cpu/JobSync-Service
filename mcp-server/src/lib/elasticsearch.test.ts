import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ProcessedJob } from "./types.js";

// Avoid loading the heavy e5 model in unit tests — embeddings are exercised separately.
vi.mock("./embeddings.js", () => ({
  embedPassages: vi.fn(async (texts: string[]) => texts.map(() => new Array(768).fill(0.1))),
  embedQuery: vi.fn(async () => new Array(768).fill(0.1)),
}));

const { toEsDoc, esDocId, indexJobs } = await import("./elasticsearch.js");

function job(overrides: Partial<ProcessedJob> = {}): ProcessedJob {
  return {
    id: "1",
    positionTitle: "Software Engineer",
    company: "Acme",
    location: "San Francisco, CA, USA",
    applyLink: "https://jobs.ashbyhq.com/acme/role-1",
    datePosted: "2026-06-01",
    salary: "$120k–$160k",
    rawFields: {},
    jobDescription: "Build things.",
    scrapeStatus: "success",
    workModel: "Remote",
    industry: "Software",
    h1bSponsored: true,
    qualifications: "5y experience",
    jobBoard: "Ashby",
    tags: ["Unicorn"],
    isNewGrad: false,
    isInternship: false,
    aiConfidence: null,
    aiProcessed: true,
    ...overrides,
  };
}

describe("toEsDoc", () => {
  it("maps a ProcessedJob to the jobs_v2 shape", () => {
    const doc = toEsDoc(job());
    expect(doc.id).toBe(esDocId("https://jobs.ashbyhq.com/acme/role-1"));
    expect(doc.id.startsWith("js_")).toBe(true);
    expect(doc.title).toBe("Software Engineer");
    expect(doc.company_name).toBe("Acme");
    expect(doc.location).toEqual({ city: "San Francisco", state: "CA", country: "USA", coordinates: null });
    expect(doc.salary).toEqual({ min_salary: 120000, max_salary: 160000, currency: "USD", period: "yearly" });
    expect(doc.remote_allowed).toBe(true);
    expect(doc.visa_sponsorship).toBe(true);
    expect(doc.job_type).toBe("full_time");
    expect(doc.experience_level).toBe("mid");
    expect(doc.posted_date).toBe("2026-06-01T00:00:00");
    expect(doc.apply_url).toBe("https://jobs.ashbyhq.com/acme/role-1");
    expect(doc.all_text).toContain("Software Engineer");
  });

  it("derives internship/entry and handles missing fields", () => {
    const doc = toEsDoc(job({ isInternship: true, isNewGrad: true, salary: null, location: null }));
    expect(doc.job_type).toBe("internship");
    expect(doc.experience_level).toBe("entry");
    expect(doc.salary).toBeNull();
    expect(doc.location).toEqual({ city: "", state: "", country: "", coordinates: null });
  });

  it("gives the same id for the same apply link (idempotent upsert)", () => {
    expect(toEsDoc(job()).id).toBe(toEsDoc(job({ positionTitle: "Different Title" })).id);
  });
});

describe("indexJobs", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubEnv("JOBSYNC_SINK", "elasticsearch");
    vi.stubEnv("JOBSYNC_ES_URL", "http://es.test");
    vi.stubEnv("JOBSYNC_ES_INDEX", "jobs_test");
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("posts an ndjson bulk body and reports indexed count", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ errors: false, items: [{ index: { _id: "js_x", status: 201 } }] }),
    });

    const result = await indexJobs([job()]);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://es.test/_bulk");
    expect(init.headers["content-type"]).toBe("application/x-ndjson");
    expect(init.body).toContain('"_index":"jobs_test"');
    expect(init.body.endsWith("\n")).toBe(true);
    expect(result).toEqual({ indexed: 1, failed: 0, errors: [] });
  });

  it("surfaces per-document failures from the bulk response", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        errors: true,
        items: [{ index: { _id: "js_x", status: 400, error: { reason: "bad mapping" } } }],
      }),
    });

    const result = await indexJobs([job()]);
    expect(result.indexed).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors[0]).toEqual({ id: "js_x", error: "bad mapping" });
  });
});
