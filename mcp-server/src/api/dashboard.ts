// Dashboard REST API (/api/* — distinct from the /api/auto-apply browser routes
// in http.ts). Every route except /api/config requires a valid Firebase ID token;
// the uid is taken from the verified token and all data is scoped to it, so users
// can only ever see their own profile, pipeline, and runs.

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthError, requireUser, upsertUser, type AuthUser } from "../lib/firebase-auth.js";
import { getPipelineGrouped, updateStatuses, type ApplicationStatus } from "../lib/pipeline.js";
import {
  activeRoles,
  readProfileFile,
  readRawResume,
  readRoles,
  writeProfileFile,
  writeRawResume,
  writeRoles,
} from "../lib/profile.js";
import { readPersonalProfile, writePersonalProfile, type PersonalProfile } from "../lib/personal-profile.js";
import { parseResume } from "../lib/resume-parser.js";
import { structureResume } from "../lib/profile-extract.js";
import { isAgentConfigured } from "../lib/agent/anthropic.js";
import { runSearchAgent, type SearchParams } from "../lib/agent/search-agent.js";
import { getStore } from "../lib/store/index.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, PATCH, PUT, OPTIONS",
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
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/** Public Firebase web config for the SPA (these values are not secrets). */
function firebaseWebConfig() {
  return {
    apiKey: process.env.FIREBASE_API_KEY ?? "",
    authDomain:
      process.env.FIREBASE_AUTH_DOMAIN ??
      (process.env.FIREBASE_PROJECT_ID ? `${process.env.FIREBASE_PROJECT_ID}.firebaseapp.com` : ""),
    projectId: process.env.FIREBASE_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? "",
  };
}

function agentCatalog() {
  const searchReady = isAgentConfigured();
  return [
    {
      id: "search",
      name: "Search",
      description: "Find and rank jobs matching your profile, then add them to your pipeline.",
      status: searchReady ? "available" : "unavailable",
    },
    {
      id: "auto-apply",
      name: "Auto-Apply",
      description: "Automatically fill and submit applications for jobs in your pipeline.",
      status: "coming-soon",
    },
  ];
}

// ── Run lifecycle ─────────────────────────────────────────────────────────────

type RunStatus = "queued" | "running" | "succeeded" | "failed";

interface RunRecord {
  id: string;
  agent: string;
  params: Record<string, unknown>;
  status: RunStatus;
  createdAt: string;
  finishedAt?: string;
  progress?: string[];
  result?: { added: number; updated: number };
  summary?: string;
  error?: string;
}

// Live, in-memory view of in-flight runs (updated as the agent streams progress);
// persisted to the docs store on start + finish. GET overlays live over persisted.
const liveRuns = new Map<string, RunRecord>();
const activeByUid = new Map<string, string>();

async function readRuns(uid: string): Promise<RunRecord[]> {
  const raw = await (await getStore()).docs.readDoc("runs", uid);
  return raw ? (JSON.parse(raw) as RunRecord[]) : [];
}

async function persistRun(uid: string, run: RunRecord): Promise<void> {
  const runs = await readRuns(uid);
  const i = runs.findIndex((r) => r.id === run.id);
  if (i >= 0) runs[i] = run;
  else runs.unshift(run);
  await (await getStore()).docs.writeDoc("runs", uid, JSON.stringify(runs.slice(0, 100)));
}

/** Kick off a Search agent run in the background. Returns the initial record. */
function startSearchRun(uid: string, params: SearchParams): RunRecord {
  const run: RunRecord = {
    id: randomUUID(),
    agent: "search",
    params: params as Record<string, unknown>,
    status: "running",
    createdAt: new Date().toISOString(),
    progress: [],
  };
  liveRuns.set(run.id, run);
  activeByUid.set(uid, run.id);
  void persistRun(uid, run).catch(() => {});

  runSearchAgent(uid, params, (msg) => {
    run.progress!.push(msg);
    if (run.progress!.length > 30) run.progress!.shift();
  })
    .then((result) => {
      run.status = "succeeded";
      run.result = { added: result.added, updated: result.updated };
      run.summary = result.summary;
    })
    .catch((err: unknown) => {
      run.status = "failed";
      run.error = err instanceof Error ? err.message : String(err);
    })
    .finally(() => {
      run.finishedAt = new Date().toISOString();
      activeByUid.delete(uid);
      void persistRun(uid, run).catch(() => {});
      // Keep the finished record live for a few minutes so the UI can read the result.
      setTimeout(() => liveRuns.delete(run.id), 5 * 60 * 1000).unref?.();
    });

  return run;
}

/** Merge persisted runs with the live in-memory view (live wins). */
async function listRuns(uid: string): Promise<RunRecord[]> {
  const persisted = await readRuns(uid);
  return persisted.map((r) => liveRuns.get(r.id) ?? r);
}

// ── Profile ───────────────────────────────────────────────────────────────────

async function getProfile(uid: string) {
  const [roles, skills, experience, projects, personal, rawResume] = await Promise.all([
    readRoles(uid),
    readProfileFile("skills", uid),
    readProfileFile("experience", uid),
    readProfileFile("projects", uid),
    readPersonalProfile(uid),
    readRawResume(uid),
  ]);
  return {
    roles,
    activeRoles: activeRoles(roles),
    skills,
    experience,
    projects,
    personal,
    hasResume: rawResume.length > 0,
  };
}

/**
 * Handle a dashboard API request. Returns true if it owned the route (response
 * sent), false if the path isn't a dashboard route (so http.ts can continue).
 */
export async function handleDashboardApi(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith("/api/")) return false;
  if (pathname.startsWith("/api/auto-apply")) return false; // handled in http.ts

  const method = req.method ?? "GET";

  if (pathname === "/api/config" && method === "GET") {
    sendJson(res, 200, firebaseWebConfig());
    return true;
  }

  // Everything below requires a verified Firebase user.
  let user: AuthUser;
  try {
    user = await requireUser(req);
  } catch (err) {
    if (err instanceof AuthError) {
      sendJson(res, 401, { error: err.message });
      return true;
    }
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    return true;
  }
  const uid = user.uid;

  try {
    if (pathname === "/api/me" && method === "GET") {
      await upsertUser(user);
      sendJson(res, 200, { uid, email: user.email });
      return true;
    }

    if (pathname === "/api/agents" && method === "GET") {
      sendJson(res, 200, { agents: agentCatalog() });
      return true;
    }

    // ── Profile ──
    if (pathname === "/api/profile" && method === "GET") {
      sendJson(res, 200, await getProfile(uid));
      return true;
    }

    if (pathname === "/api/profile" && method === "PUT") {
      const body = await readJsonBody(req);
      if (Array.isArray(body.roles)) {
        const r = await readRoles(uid);
        await writeRoles({ ...r, custom: (body.roles as string[]).map(String) }, uid);
      }
      if (typeof body.skills === "string") await writeProfileFile("skills", body.skills, uid);
      if (typeof body.experience === "string") await writeProfileFile("experience", body.experience, uid);
      if (typeof body.projects === "string") await writeProfileFile("projects", body.projects, uid);
      if (body.personal && typeof body.personal === "object") {
        await writePersonalProfile(body.personal as Partial<PersonalProfile>, uid);
      }
      sendJson(res, 200, await getProfile(uid));
      return true;
    }

    // POST /api/profile/resume — base64 resume → parse → structure → store (scoped)
    if (pathname === "/api/profile/resume" && method === "POST") {
      if (!isAgentConfigured()) {
        sendJson(res, 503, { error: "Resume structuring needs ANTHROPIC_API_KEY (not configured)." });
        return true;
      }
      const body = await readJsonBody(req);
      const base64 = String(body.base64 ?? "");
      const filename = String(body.filename ?? "resume.pdf");
      if (!base64) {
        sendJson(res, 400, { error: "base64 file content is required" });
        return true;
      }
      const dir = join(tmpdir(), `jobsync-resume-${randomUUID()}`);
      const path = join(dir, filename.replace(/[^\w.\-]/g, "_"));
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(path, Buffer.from(base64, "base64"));
        const text = await parseResume(path);
        await writeRawResume(text, uid);
        const structured = await structureResume(text);
        await Promise.all([
          writeRoles({ detected: structured.roles, custom: [], excluded: [] }, uid),
          writeProfileFile("skills", structured.skills.map((s) => `- ${s}`).join("\n"), uid),
          writeProfileFile("experience", structured.experience, uid),
          writeProfileFile("projects", structured.projects, uid),
        ]);
        sendJson(res, 200, { ok: true, chars: text.length, ...(await getProfile(uid)) });
      } finally {
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      }
      return true;
    }

    // ── Pipeline ──
    if (pathname === "/api/pipeline" && method === "GET") {
      sendJson(res, 200, await getPipelineGrouped(undefined, uid));
      return true;
    }

    if (pathname.startsWith("/api/pipeline/") && method === "PATCH") {
      const id = decodeURIComponent(pathname.slice("/api/pipeline/".length));
      const body = await readJsonBody(req);
      const status = body.status as ApplicationStatus | undefined;
      if (!status) {
        sendJson(res, 400, { error: "status is required" });
        return true;
      }
      const result = await updateStatuses([{ id, status, notes: body.notes as string | undefined }], uid);
      sendJson(res, result.matched > 0 ? 200 : 404, result);
      return true;
    }

    // ── Runs ──
    if (pathname === "/api/runs" && method === "GET") {
      sendJson(res, 200, { runs: await listRuns(uid) });
      return true;
    }

    // GET /api/runs/:id — live status of a single run
    if (pathname.startsWith("/api/runs/") && method === "GET") {
      const id = decodeURIComponent(pathname.slice("/api/runs/".length));
      const run = liveRuns.get(id) ?? (await readRuns(uid)).find((r) => r.id === id);
      if (!run) {
        sendJson(res, 404, { error: "run not found" });
        return true;
      }
      sendJson(res, 200, run);
      return true;
    }

    if (pathname === "/api/runs" && method === "POST") {
      const body = await readJsonBody(req);
      const agent = String(body.agent ?? "");
      const params = (body.params as Record<string, unknown>) ?? {};

      if (agent === "search") {
        if (!isAgentConfigured()) {
          sendJson(res, 503, { error: "Search agent is not configured (ANTHROPIC_API_KEY missing)." });
          return true;
        }
        if (activeByUid.has(uid)) {
          sendJson(res, 409, { error: "A search is already running. Wait for it to finish." });
          return true;
        }
        const run = startSearchRun(uid, {
          lookbackHours: typeof params.lookbackHours === "number" ? params.lookbackHours : undefined,
          roles: Array.isArray(params.roles) ? (params.roles as string[]) : undefined,
          companies: Array.isArray(params.companies) ? (params.companies as string[]) : undefined,
        });
        sendJson(res, 202, { run });
        return true;
      }

      if (agent === "auto-apply") {
        const run: RunRecord = {
          id: randomUUID(),
          agent,
          params,
          status: "queued",
          createdAt: new Date().toISOString(),
        };
        await persistRun(uid, run);
        sendJson(res, 202, { run, message: "Auto-Apply ships in the next release — your request is saved." });
        return true;
      }

      sendJson(res, 400, { error: `unknown agent: ${agent}` });
      return true;
    }

    sendJson(res, 404, { error: "not found" });
    return true;
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    return true;
  }
}
