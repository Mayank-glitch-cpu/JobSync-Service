// Mutu integration API (/api/mutu/*). JobSync as the data-aggregation service
// behind Mutu AI: demographics ingestion, resume parsing (cloud Qwen3VL worker),
// role synthesis over the user base, and job retrieval for Mutu's recsys.
//
// Auth: same service bearer token as /api/external (JOBSYNC_REMOTE_BEARER_TOKEN),
// enforced by http.ts before dispatch. See docs/mutu-integration.md.

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  getResume,
  getUser,
  ingestJobs,
  queryJobs,
  saveResume,
  upsertUser,
  type MutuJobInput,
  type MutuUserInput,
} from "../lib/mutu/db.js";
import { isEffectivelyEmpty, normalizeParsedResume } from "../lib/mutu/schema.js";
import { parseResumeUpload, parserMode } from "../lib/mutu/parser-client.js";
import { latestRoleSynthRun, synthesizeRoles } from "../lib/mutu/role-synth.js";
import { startSearchRun } from "./dashboard.js";
import { isAgentConfigured } from "../lib/agent/anthropic.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  });
  res.end(JSON.stringify(body));
}

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

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

// ── Users ────────────────────────────────────────────────────────────────────

async function handleUpsertUser(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const email = str(body.email);
  if (!email) {
    sendJson(res, 400, { error: "email is required" });
    return;
  }
  const input: MutuUserInput = {
    email,
    firstName: str(body.firstName ?? body.first_name),
    lastName: str(body.lastName ?? body.last_name),
    country: str(body.country),
    workAuthorization: str(body.workAuthorization ?? body.work_authorization),
    linkedin: str(body.linkedin),
    github: str(body.github),
    googleScholar: str(body.googleScholar ?? body.google_scholar),
    extraLinks:
      body.extraLinks && typeof body.extraLinks === "object"
        ? (body.extraLinks as Record<string, string>)
        : undefined,
  };
  const user = await upsertUser(input);
  sendJson(res, 200, { user });
}

async function handleGetUser(res: ServerResponse, userId: string): Promise<void> {
  const user = await getUser(userId);
  if (!user) {
    sendJson(res, 404, { error: "user not found" });
    return;
  }
  const resume = await getResume(userId);
  sendJson(res, 200, { user, resume });
}

// ── Resume ingestion → store → preview ───────────────────────────────────────
//
// Primary path: Mutu already parses the resume with its own model (Sonnet 5)
// and POSTs the resulting 23-field JSON directly:
//   { "resume": { ...23-field record... }, "parserModel": "claude-sonnet-5" }
// No file transfer, no GPU worker, no cold start — we normalize and store.
//
// Fallback path: { filename, contentBase64 } forwards the raw file to the
// optional parser worker (see lib/mutu/parser-client.ts).

async function handleUploadResume(
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
): Promise<void> {
  const user = await getUser(userId);
  if (!user) {
    sendJson(res, 404, { error: "user not found — create it via POST /api/mutu/users first" });
    return;
  }
  const body = await readJsonBody(req);

  // Primary: pre-parsed JSON straight from Mutu's parser.
  if (body.resume !== undefined) {
    let parsed;
    try {
      parsed = normalizeParsedResume(body.resume);
    } catch (err) {
      sendJson(res, 422, {
        error: `resume payload failed 23-field schema validation: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    if (isEffectivelyEmpty(parsed)) {
      sendJson(res, 422, {
        error:
          "resume payload normalized to an empty record — the JSON does not match the 23-field schema " +
          "(expected keys like first_name, desired_position, skills: [{skill_name, level}], experiences, educations). " +
          "Map your parser's output to the 23-field record before POSTing. See docs/mutu-integration.md.",
      });
      return;
    }
    const parserModel = str(body.parserModel ?? body.parser_model) ?? "mutu-provided";
    const stored = await saveResume(userId, parsed, parserModel);
    sendJson(res, 200, {
      resumeId: stored.resumeId,
      userId,
      parserModel,
      parserMode: "pre-parsed",
      resume: parsed,
    });
    return;
  }

  // Fallback: raw file → parser worker (or stub).
  const filename = str(body.filename);
  const contentBase64 = typeof body.contentBase64 === "string" ? body.contentBase64 : null;
  if (!filename || !contentBase64) {
    sendJson(res, 400, {
      error: "Provide either { resume: {...} } (pre-parsed JSON) or { filename, contentBase64 } (raw file).",
    });
    return;
  }

  const { parsed, parserModel } = await parseResumeUpload({ filename, contentBase64 });
  const stored = await saveResume(userId, parsed, parserModel);

  // Mutu renders this as the preview screen.
  sendJson(res, 200, {
    resumeId: stored.resumeId,
    userId,
    parserModel,
    parserMode: parserMode(),
    resume: parsed,
  });
}

async function handleGetResume(res: ServerResponse, userId: string): Promise<void> {
  const resume = await getResume(userId);
  if (!resume) {
    sendJson(res, 404, { error: "no resume stored for this user" });
    return;
  }
  sendJson(res, 200, resume);
}

// ── Role synthesis ───────────────────────────────────────────────────────────

async function handleSynthesizeRoles(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const run = await synthesizeRoles({ guidance: str(body.guidance) ?? undefined });

  // Optionally seed the existing agentic search pipeline with the synthesized roles.
  let search: { runId: string; poll: string } | undefined;
  if (body.seedSearch === true) {
    const uid = str(body.uid);
    if (!uid) {
      sendJson(res, 400, { error: "seedSearch requires a uid (whose pipeline the search writes to)" });
      return;
    }
    if (!isAgentConfigured()) {
      sendJson(res, 503, { error: "Search agent not configured (ANTHROPIC_API_KEY missing)" });
      return;
    }
    const searchRun = startSearchRun(uid, { roles: run.roles.map((r) => r.role) });
    search = {
      runId: searchRun.id,
      poll: `/api/external/search/${searchRun.id}?uid=${encodeURIComponent(uid)}`,
    };
  }

  sendJson(res, 200, { run, ...(search ? { search } : {}) });
}

async function handleLatestRoles(res: ServerResponse): Promise<void> {
  const run = await latestRoleSynthRun();
  if (!run) {
    sendJson(res, 404, { error: "no role-synthesis runs yet" });
    return;
  }
  sendJson(res, 200, { run });
}

// ── Jobs ─────────────────────────────────────────────────────────────────────

async function handleIngestJobs(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  if (!Array.isArray(body.jobs)) {
    sendJson(res, 400, { error: "jobs array is required" });
    return;
  }
  const jobs: MutuJobInput[] = (body.jobs as Array<Record<string, unknown>>).map((j) => ({
    company: String(j.company ?? ""),
    positionTitle: String(j.positionTitle ?? j.position_title ?? ""),
    applyLink: str(j.applyLink ?? j.apply_link),
    location: str(j.location),
    source: str(j.source),
    tags: Array.isArray(j.tags) ? j.tags.map(String) : [],
    postedAt: str(j.postedAt ?? j.posted_at ?? j.datePosted),
  }));
  const inserted = await ingestJobs(jobs);
  sendJson(res, 200, { received: jobs.length, inserted });
}

async function handleQueryJobs(res: ServerResponse, url: URL): Promise<void> {
  const skillsRaw = url.searchParams.get("skills");
  const jobs = await queryJobs({
    role: url.searchParams.get("role") ?? undefined,
    country: url.searchParams.get("country") ?? undefined,
    skills: skillsRaw ? skillsRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    limit: Number(url.searchParams.get("limit")) || undefined,
  });
  sendJson(res, 200, { jobs, count: jobs.length });
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

/**
 * Handle a Mutu API request. Returns true if it owned the route. Auth is
 * enforced by http.ts before this runs.
 */
export async function handleMutuApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const pathname = url.pathname;
  if (!pathname.startsWith("/api/mutu/")) return false;
  const method = req.method ?? "GET";

  try {
    if (pathname === "/api/mutu/users" && method === "POST") {
      await handleUpsertUser(req, res);
      return true;
    }

    const resumeMatch = pathname.match(/^\/api\/mutu\/users\/([^/]+)\/resume$/);
    if (resumeMatch?.[1]) {
      const userId = decodeURIComponent(resumeMatch[1]);
      if (method === "POST") await handleUploadResume(req, res, userId);
      else if (method === "GET") await handleGetResume(res, userId);
      else sendJson(res, 405, { error: "method not allowed" });
      return true;
    }

    const userMatch = pathname.match(/^\/api\/mutu\/users\/([^/]+)$/);
    if (userMatch?.[1]) {
      if (method !== "GET") {
        sendJson(res, 405, { error: "method not allowed" });
        return true;
      }
      await handleGetUser(res, decodeURIComponent(userMatch[1]));
      return true;
    }

    if (pathname === "/api/mutu/roles/synthesize" && method === "POST") {
      await handleSynthesizeRoles(req, res);
      return true;
    }
    if (pathname === "/api/mutu/roles/latest" && method === "GET") {
      await handleLatestRoles(res);
      return true;
    }

    if (pathname === "/api/mutu/jobs/ingest" && method === "POST") {
      await handleIngestJobs(req, res);
      return true;
    }
    if (pathname === "/api/mutu/jobs" && method === "GET") {
      await handleQueryJobs(res, url);
      return true;
    }

    sendJson(res, 404, { error: "not found" });
    return true;
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    return true;
  }
}
