// External Agent API (/api/external/*). A machine-to-machine surface for other
// apps to drive JobSync without a browser (so Firebase login doesn't apply).
// Every route is gated by the same service bearer token as /api/auto-apply
// (JOBSYNC_REMOTE_BEARER_TOKEN); see isServiceAuthorized in http.ts.
//
// Three tiers:
//   POST /api/external/profile           → create/update the search profile for a
//                                          uid from user metadata + a resume file.
//   GET  /api/external/profile?uid=…     → read that profile back.
//   POST /api/external/search            → async, LLM-vetted agentic search that
//                                          writes to a specific user's pipeline.
//   GET  /api/external/search/:runId     → poll a search run's status.
//   POST /api/external/jobs/breadth      → synchronous, non-LLM, no-persistence
//                                          pull straight from ATS boards + filters.
//
// The caller must supply an explicit `uid` for the profile and search tiers —
// all data is scoped to it exactly as the dashboard routes scope to the
// Firebase uid. The normal onboarding order is: POST /profile → POST /search.

import type { IncomingMessage, ServerResponse } from "node:http";
import { isAgentConfigured } from "../lib/agent/anthropic.js";
import { isLlmConfigured } from "../lib/agent/llm.js";
import { ingestResume, profileSnapshot } from "../lib/profile-ingest.js";
import { readRoles, writeRoles } from "../lib/profile.js";
import { writePersonalProfile, type PersonalProfile } from "../lib/personal-profile.js";
import { getRun, hasActiveSearch, startSearchRun } from "./dashboard.js";
import { fetchAshby, fetchGreenhouse, fetchLever, fetchWorkday } from "../lib/fast-path.js";
import { passesTitleFilter } from "../lib/filter.js";
import type { RawJob } from "../lib/types.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  });
  res.end(JSON.stringify(body));
}

// 25 MB cap — a base64 resume rides inside the JSON body on /profile.
async function readJsonBody(req: IncomingMessage, maxBytes = 25 * 1024 * 1024): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error("Request body too large."));
        req.destroy();
        return;
      }
      body += c;
    });
    req.on("end", () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body) as Record<string, unknown>);
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

const asStringArray = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : undefined;

// ── Breadth: synchronous ATS pull ───────────────────────────────────────────────

type BreadthSource = "greenhouse" | "lever" | "ashby" | "workday";
const BREADTH_SOURCES: BreadthSource[] = ["greenhouse", "lever", "ashby", "workday"];

const FETCHERS: Record<BreadthSource, (ref: string) => Promise<RawJob[]>> = {
  greenhouse: fetchGreenhouse,
  lever: fetchLever,
  ashby: fetchAshby,
  workday: fetchWorkday,
};

interface SourceOutcome {
  source: BreadthSource;
  /** Slug (greenhouse/lever/ashby) or board URL (workday). */
  ref: string;
  ok: boolean;
  fetched: number;
  error?: string;
}

/**
 * Fetch a company board directly and return its raw jobs. Never throws — a bad
 * slug or a 404 becomes a failed SourceOutcome so one dead board can't sink the
 * whole batch.
 */
async function fetchOne(source: BreadthSource, ref: string): Promise<{ jobs: RawJob[]; outcome: SourceOutcome }> {
  try {
    const jobs = await FETCHERS[source](ref);
    return { jobs, outcome: { source, ref, ok: true, fetched: jobs.length } };
  } catch (err) {
    return {
      jobs: [],
      outcome: { source, ref, ok: false, fetched: 0, error: err instanceof Error ? err.message : String(err) },
    };
  }
}

/** Parse the `sources` object of a breadth request into (source, ref) pairs. */
function collectSourceRefs(sources: unknown): Array<{ source: BreadthSource; ref: string }> {
  const out: Array<{ source: BreadthSource; ref: string }> = [];
  if (!sources || typeof sources !== "object") return out;
  const obj = sources as Record<string, unknown>;
  for (const source of BREADTH_SOURCES) {
    for (const ref of asStringArray(obj[source]) ?? []) {
      out.push({ source, ref });
    }
  }
  return out;
}

async function handleBreadth(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const refs = collectSourceRefs(body.sources);
  if (refs.length === 0) {
    sendJson(res, 400, {
      error:
        "Provide `sources` with at least one board, e.g. { sources: { greenhouse: [\"stripe\"], lever: [\"netflix\"] } }.",
    });
    return;
  }

  const include = asStringArray(body.include);
  const exclude = asStringArray(body.exclude);
  const usOnly = body.usOnly === undefined ? true : Boolean(body.usOnly);
  const limitRaw = typeof body.limit === "number" ? body.limit : 200;
  const limit = Math.max(1, Math.min(1000, Math.floor(limitRaw)));

  const settled = await Promise.all(refs.map(({ source, ref }) => fetchOne(source, ref)));

  const outcomes = settled.map((s) => s.outcome);
  const allJobs = settled.flatMap((s) => s.jobs);
  const fetched = allJobs.length;

  // Non-LLM filter: keyword title match + optional US-location gate. Callers who
  // want everything can pass include: [] to disable the keyword requirement.
  const filtered = allJobs.filter((j) =>
    passesTitleFilter({ title: j.positionTitle, location: j.location }, { include, exclude, usOnly }),
  );
  const jobs = filtered.slice(0, limit);

  sendJson(res, 200, {
    jobs,
    counts: { fetched, matched: filtered.length, returned: jobs.length },
    sources: outcomes,
  });
}

// ── Profile: create the agentic-search profile for a uid ─────────────────────────
//
// POST /api/external/profile
//   {
//     "uid": "acme-user-123",              // required — namespace for all this user's data
//     "personal": { "firstName": "Ada", "email": "ada@x.com", "workAuthorization": "US Citizen", ... },
//     "resume": { "filename": "ada.pdf", "base64": "JVBERi0..." },   // .pdf/.docx/.txt/.md
//     "roles": ["Backend Engineer"]        // optional override of the LLM-detected roles
//   }
//
// The resume is parsed to text, the original bytes are kept for Auto-Apply file
// uploads, and an LLM structures it into roles/skills/experience/projects — the
// same profile the Search and Auto-Apply agents read. Personal metadata alone
// (no resume) is a valid partial update.

/** Personal-profile keys accepted from callers, with snake_case aliases. */
const PERSONAL_KEYS: Array<keyof PersonalProfile> = [
  "firstName", "lastName", "email", "phone",
  "linkedinUrl", "githubUrl", "portfolioUrl", "twitterUrl", "scholarUrl", "otherUrls",
  "workAuthorization", "requiresSponsorship",
  "city", "state", "country",
  "ethnicity", "gender", "pronouns", "veteranStatus", "disabilityStatus", "disabilityDetails",
];

const snake = (s: string): string => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** Pick known personal fields out of a caller payload, accepting either case style. */
function pickPersonal(src: Record<string, unknown>): Partial<PersonalProfile> {
  const out: Record<string, unknown> = {};
  for (const key of PERSONAL_KEYS) {
    const v = src[key] ?? src[snake(key)];
    if (v === undefined || v === null) continue;
    out[key] = key === "requiresSponsorship" ? Boolean(v) : String(v);
  }
  return out as Partial<PersonalProfile>;
}

async function handleUpsertProfile(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const uid = typeof body.uid === "string" ? body.uid.trim() : "";
  if (!uid) {
    sendJson(res, 400, { error: "uid is required — it namespaces this user's profile, pipeline and runs." });
    return;
  }

  // Metadata may arrive nested under `personal` or flat alongside `uid`.
  const personalSrc = (body.personal && typeof body.personal === "object")
    ? (body.personal as Record<string, unknown>)
    : body;
  const personal = pickPersonal(personalSrc);

  const resume = (body.resume && typeof body.resume === "object")
    ? (body.resume as Record<string, unknown>)
    : null;
  const base64 = typeof resume?.base64 === "string" ? resume.base64 : null;
  const roleOverride = asStringArray(body.roles);

  if (!base64 && Object.keys(personal).length === 0 && !roleOverride) {
    sendJson(res, 400, {
      error:
        "Nothing to write. Provide `resume: { filename, base64 }`, `personal: {...}` metadata, and/or `roles: [...]`.",
    });
    return;
  }
  if (base64 && !isLlmConfigured()) {
    sendJson(res, 503, {
      error:
        "Resume structuring needs an LLM configured (ANTHROPIC_API_KEY, or JOBSYNC_LLM_PROVIDER=openai + JOBSYNC_LLM_API_KEY).",
    });
    return;
  }

  if (Object.keys(personal).length > 0) await writePersonalProfile(personal, uid);

  let chars: number | undefined;
  if (base64) {
    const filename = typeof resume?.filename === "string" ? resume.filename : undefined;
    ({ chars } = await ingestResume(uid, { base64, filename }));
  }

  // Applied after ingestion so an explicit override wins over detected roles.
  if (roleOverride) {
    const r = await readRoles(uid);
    await writeRoles({ ...r, custom: roleOverride }, uid);
  }

  sendJson(res, 200, {
    ok: true,
    uid,
    ...(chars === undefined ? {} : { resumeChars: chars }),
    profile: await profileSnapshot(uid),
    next: `POST /api/external/search with { "uid": "${uid}" }`,
  });
}

async function handleGetProfile(res: ServerResponse, uid: string): Promise<void> {
  if (!uid) {
    sendJson(res, 400, { error: "uid query parameter is required." });
    return;
  }
  sendJson(res, 200, { uid, profile: await profileSnapshot(uid) });
}

// ── Search: async agentic run scoped to a uid ────────────────────────────────────

async function handleStartSearch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const uid = typeof body.uid === "string" ? body.uid.trim() : "";
  if (!uid) {
    sendJson(res, 400, { error: "uid is required — the search writes to that user's pipeline." });
    return;
  }
  if (!isAgentConfigured()) {
    sendJson(res, 503, { error: "Search agent is not configured (ANTHROPIC_API_KEY missing)." });
    return;
  }
  if (hasActiveSearch(uid)) {
    sendJson(res, 409, { error: "A search is already running for this user. Wait for it to finish." });
    return;
  }
  const params = (body.params as Record<string, unknown>) ?? body;
  const run = startSearchRun(uid, {
    lookbackHours: typeof params.lookbackHours === "number" ? params.lookbackHours : undefined,
    roles: asStringArray(params.roles),
    companies: asStringArray(params.companies),
  });
  sendJson(res, 202, {
    runId: run.id,
    status: run.status,
    poll: `/api/external/search/${run.id}?uid=${encodeURIComponent(uid)}`,
  });
}

async function handleGetSearch(res: ServerResponse, runId: string, uid: string): Promise<void> {
  if (!uid) {
    sendJson(res, 400, { error: "uid query parameter is required." });
    return;
  }
  const run = await getRun(uid, runId);
  if (!run || run.agent !== "search") {
    sendJson(res, 404, { error: "run not found for this user." });
    return;
  }
  sendJson(res, 200, {
    runId: run.id,
    status: run.status,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
    result: run.result,
    summary: run.summary,
    error: run.error,
    progress: run.progress,
  });
}

/**
 * Handle an external-agent API request. Returns true if it owned the route
 * (response sent), false if the path isn't an /api/external route.
 *
 * Auth is enforced by the caller (http.ts) before this runs — this module only
 * dispatches routes it recognizes.
 */
export async function handleExternalApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const pathname = url.pathname;
  if (!pathname.startsWith("/api/external/")) return false;
  const method = req.method ?? "GET";

  try {
    if (pathname === "/api/external/jobs/breadth") {
      if (method !== "POST") {
        sendJson(res, 405, { error: "method not allowed" });
        return true;
      }
      await handleBreadth(req, res);
      return true;
    }

    if (pathname === "/api/external/profile") {
      if (method === "POST") await handleUpsertProfile(req, res);
      else if (method === "GET") await handleGetProfile(res, (url.searchParams.get("uid") ?? "").trim());
      else sendJson(res, 405, { error: "method not allowed" });
      return true;
    }

    if (pathname === "/api/external/search") {
      if (method !== "POST") {
        sendJson(res, 405, { error: "method not allowed" });
        return true;
      }
      await handleStartSearch(req, res);
      return true;
    }

    if (pathname.startsWith("/api/external/search/")) {
      if (method !== "GET") {
        sendJson(res, 405, { error: "method not allowed" });
        return true;
      }
      const runId = decodeURIComponent(pathname.slice("/api/external/search/".length));
      await handleGetSearch(res, runId, (url.searchParams.get("uid") ?? "").trim());
      return true;
    }

    sendJson(res, 404, { error: "not found" });
    return true;
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    return true;
  }
}
