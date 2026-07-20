// External Agent API (/api/external/*). A machine-to-machine surface for other
// apps to drive JobSync without a browser (so Firebase login doesn't apply).
// Every route is gated by the same service bearer token as /api/auto-apply
// (JOBSYNC_REMOTE_BEARER_TOKEN); see isServiceAuthorized in http.ts.
//
// Two tiers:
//   POST /api/external/search            → async, LLM-vetted agentic search that
//                                          writes to a specific user's pipeline.
//   GET  /api/external/search/:runId     → poll a search run's status.
//   POST /api/external/jobs/breadth      → synchronous, non-LLM, no-persistence
//                                          pull straight from ATS boards + filters.
//
// The caller must supply an explicit `uid` for the search tier — all data is
// scoped to it exactly as the dashboard routes scope to the Firebase uid.

import type { IncomingMessage, ServerResponse } from "node:http";
import { isAgentConfigured } from "../lib/agent/anthropic.js";
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

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
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
