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
  writeResumeBlob,
  writeRoles,
} from "../lib/profile.js";
import { readPersonalProfile, writePersonalProfile, type PersonalProfile } from "../lib/personal-profile.js";
import { rememberAnswers } from "../lib/qa-memory.js";
import type { UnansweredField } from "../lib/ai-fill.js";
import { parseResume } from "../lib/resume-parser.js";
import { structureResume } from "../lib/profile-extract.js";
import { isAgentConfigured } from "../lib/agent/anthropic.js";
import { isLlmConfigured } from "../lib/agent/llm.js";
import { runSearchAgent, type SearchParams } from "../lib/agent/search-agent.js";
import {
  prepareApplication,
  submitPreparedApplication,
  submitApplicationCode,
  discardPreparedApplication,
  tweakAnswer,
  editAnswer,
  type ApplyParams,
  type PreviewFrame,
  type ProposedField,
} from "../lib/agent/auto-apply-agent.js";
import { captureLiveFrame, detectAts } from "../lib/browser-apply.js";
import { screenshotToData } from "../lib/gcs.js";
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
      description:
        "Fill a pipeline job's application from your profile and show a preview. You approve before anything is submitted. Start one from a job in your Pipeline.",
      status: searchReady ? "available" : "unavailable",
    },
  ];
}

// ── Run lifecycle ─────────────────────────────────────────────────────────────

// Max log lines retained per run. Kept generous so the right-side log panel can
// show the full trace of a run (live and after the fact), not just a tail.
const MAX_LOG_LINES = 300;

// "awaiting_approval": an Auto-Apply preview is filled and the browser session is
// held open until the user approves (submit) or discards it. "cancelled": discarded.
// "awaiting_code": submit reached an emailed-verification-code gate; the session is
// held open until the user supplies the code via the /code route.
type RunStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "awaiting_input"
  | "awaiting_code"
  | "succeeded"
  | "failed"
  | "cancelled";

// Max preview screenshots kept per run (in memory, live). Older frames are dropped.
const MAX_PREVIEWS = 6;

/** Append a timestamped line to a run's log, trimming to the retention cap. */
function appendLog(run: RunRecord, msg: string): void {
  const ts = new Date().toISOString().slice(11, 19); // HH:MM:SS (UTC)
  (run.progress ??= []).push(`[${ts}] ${msg}`);
  if (run.progress.length > MAX_LOG_LINES) run.progress.shift();
}

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
  // Auto-Apply: live screenshot previews + the proposed answers awaiting approval.
  previews?: PreviewFrame[];
  proposed?: { filled: ProposedField[]; unfilledRequired: string[] };
  /** Required questions the agent can't answer from the profile — the console asks
   *  the user, and the answers are saved to per-user Q&A memory. */
  needsInput?: UnansweredField[];
  applyLink?: string;
  jobId?: string;
  company?: string;
  jobTitle?: string;
  // Job metadata for the console's left-top card. Sourced from the pipeline entry
  // (location/datePosted/…) and enriched with what the agent detected (ats/fields).
  meta?: {
    location?: string;
    datePosted?: string;
    industry?: string;
    tags?: string;
    fitScore?: string;
    atsHint?: string;
    totalFields?: number;
  };
  /** When true the run auto-submits after a clean preview instead of waiting. */
  autonomous?: boolean;
  /** Submit hit an emailed-code gate — the console shows a code input. */
  needsEmailCode?: boolean;
  /** Submit is blocked by a CAPTCHA — the console tells the user to finish on the apply page. */
  needsCaptcha?: boolean;
}

/** Attach a preview frame to a run, capping the in-memory history. */
function addPreview(run: RunRecord, p: PreviewFrame): void {
  (run.previews ??= []).push(p);
  if (run.previews.length > MAX_PREVIEWS) run.previews.shift();
}

// Live, in-memory view of in-flight runs (updated as the agent streams progress);
// persisted to the docs store on start + finish. GET overlays live over persisted.
const liveRuns = new Map<string, RunRecord>();
const activeByUid = new Map<string, string>();

async function readRuns(uid: string): Promise<RunRecord[]> {
  const raw = await (await getStore()).docs.readDoc("runs", uid);
  return raw ? (JSON.parse(raw) as RunRecord[]) : [];
}

// Persisting base64 screenshots would blow past the docs store's per-document size
// limit (Firestore caps at ~1MB). Keep durable GCS URLs, drop inline base64 — the
// live in-memory run still carries the full frames for the active preview/approve flow.
function sanitizeForPersist(run: RunRecord): RunRecord {
  if (!run.previews?.length) return run;
  return {
    ...run,
    previews: run.previews
      .filter((p) => p.url)
      .map(({ stage, caption, url, at }) => ({ stage, caption, url, at })),
  };
}

async function persistRun(uid: string, run: RunRecord): Promise<void> {
  const runs = await readRuns(uid);
  const clean = sanitizeForPersist(run);
  const i = runs.findIndex((r) => r.id === run.id);
  if (i >= 0) runs[i] = clean;
  else runs.unshift(clean);
  await (await getStore()).docs.writeDoc("runs", uid, JSON.stringify(runs.slice(0, 100)));
}

/** True when this user already has a Search run in flight (one at a time). */
export function hasActiveSearch(uid: string): boolean {
  return activeByUid.has(uid);
}

/** Look up a single run for a user — live in-memory record if present, else persisted. */
export async function getRun(uid: string, id: string): Promise<RunRecord | undefined> {
  return liveRuns.get(id) ?? (await readRuns(uid)).find((r) => r.id === id);
}

/** Kick off a Search agent run in the background. Returns the initial record. */
export function startSearchRun(uid: string, params: SearchParams): RunRecord {
  const run: RunRecord = {
    id: randomUUID(),
    agent: "search",
    params: params as Record<string, unknown>,
    status: "running",
    createdAt: new Date().toISOString(),
    progress: [],
  };
  appendLog(run, "Search run started.");
  liveRuns.set(run.id, run);
  activeByUid.set(uid, run.id);
  void persistRun(uid, run).catch(() => {});

  runSearchAgent(uid, params, (msg) => appendLog(run, msg))
    .then((result) => {
      run.status = "succeeded";
      run.result = { added: result.added, updated: result.updated };
      run.summary = result.summary;
      appendLog(run, `Done — added ${result.added}, updated ${result.updated}.`);
    })
    .catch((err: unknown) => {
      run.status = "failed";
      run.error = err instanceof Error ? err.message : String(err);
      appendLog(run, `Failed: ${run.error}`);
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

// ── Auto-Apply (preview → approve) ──────────────────────────────────────────────
// The browser session in browser-apply.ts is a process-wide singleton, so only one
// application can be prepared / awaiting approval at a time. We track that run here.
let applyRun: { uid: string; id: string } | null = null;

/** Kick off an Auto-Apply preview run in the background. Returns the initial record. */
function startApplyRun(uid: string, params: ApplyParams, opts: { autonomous?: boolean; meta?: RunRecord["meta"] } = {}): RunRecord {
  const run: RunRecord = {
    id: randomUUID(),
    agent: "auto-apply",
    params: params as unknown as Record<string, unknown>,
    status: "running",
    createdAt: new Date().toISOString(),
    progress: [],
    previews: [],
    applyLink: params.applyLink,
    jobId: params.jobId,
    company: params.company,
    jobTitle: params.jobTitle,
    autonomous: opts.autonomous,
    meta: opts.meta,
  };
  appendLog(
    run,
    opts.autonomous
      ? "Auto-Apply started in autonomous mode — will fill and submit without stopping."
      : "Auto-Apply started — preparing a preview (nothing is submitted yet).",
  );
  liveRuns.set(run.id, run);
  applyRun = { uid, id: run.id };
  void persistRun(uid, run).catch(() => {});

  prepareApplication(
    uid,
    params,
    (msg) => appendLog(run, msg),
    (frame) => addPreview(run, frame),
  )
    .then(async (prepared) => {
      run.meta = { ...run.meta, atsHint: prepared.atsHint, totalFields: prepared.totalFields };
      run.proposed = { filled: prepared.filled, unfilledRequired: prepared.unfilledRequired };
      run.needsInput = prepared.needsInput;
      // The agent hit required questions it can't answer from the profile — pause and
      // ask the user (their answers are saved to Q&A memory and reused next time).
      if (prepared.needsInput.length > 0) {
        run.status = "awaiting_input";
        appendLog(
          run,
          `Paused — ${prepared.needsInput.length} required question(s) need your input. Answer them to continue.`,
        );
        void persistRun(uid, run).catch(() => {});
        return;
      }
      // Autonomous: submit immediately when nothing required is missing. (CAPTCHA /
      // email-code gates still surface in the submit result and stop the flow there.)
      if (opts.autonomous && prepared.unfilledRequired.length === 0) {
        await approveApplyRun(uid, run);
        return;
      }
      run.status = "awaiting_approval";
      if (opts.autonomous) {
        appendLog(
          run,
          `Autonomous mode paused — ${prepared.unfilledRequired.length} required field(s) need your input before submitting.`,
        );
      } else {
        appendLog(run, "Preview ready — review the filled form, then Approve to submit or Discard.");
      }
      void persistRun(uid, run).catch(() => {});
    })
    .catch((err: unknown) => {
      run.status = "failed";
      run.error = err instanceof Error ? err.message : String(err);
      run.finishedAt = new Date().toISOString();
      appendLog(run, `Failed: ${run.error}`);
      applyRun = null;
      void discardPreparedApplication().catch(() => {});
      void persistRun(uid, run).catch(() => {});
      setTimeout(() => liveRuns.delete(run.id), 5 * 60 * 1000).unref?.();
    });

  return run;
}

/** Apply a freshly prepared application to a run: pause for user input, auto-submit
 *  (autonomous), or move to awaiting approval. Shared by the initial prepare and the
 *  post-answers re-prepare. */
async function applyPreparedResult(
  uid: string,
  run: RunRecord,
  prepared: Awaited<ReturnType<typeof prepareApplication>>,
): Promise<void> {
  run.meta = { ...run.meta, atsHint: prepared.atsHint, totalFields: prepared.totalFields };
  run.proposed = { filled: prepared.filled, unfilledRequired: prepared.unfilledRequired };
  run.needsInput = prepared.needsInput;
  if (prepared.needsInput.length > 0) {
    run.status = "awaiting_input";
    appendLog(
      run,
      `Paused — ${prepared.needsInput.length} required question(s) need your input. Answer them to continue.`,
    );
    await persistRun(uid, run).catch(() => {});
    return;
  }
  if (run.autonomous && prepared.unfilledRequired.length === 0) {
    await approveApplyRun(uid, run);
    return;
  }
  run.status = "awaiting_approval";
  appendLog(run, "Preview ready — review the filled form, then Approve to submit or Discard.");
  await persistRun(uid, run).catch(() => {});
}

/** Re-prepare an application after the user supplied missing answers (now in Q&A
 *  memory). Reuses the open browser session; updates the run in place. */
async function reprepareAfterAnswers(uid: string, run: RunRecord): Promise<void> {
  run.status = "running";
  appendLog(run, "Re-checking the form with your answers…");
  const params = run.params as unknown as ApplyParams;
  try {
    const prepared = await prepareApplication(
      uid,
      params,
      (msg) => appendLog(run, msg),
      (frame) => addPreview(run, frame),
    );
    await applyPreparedResult(uid, run, prepared);
  } catch (err) {
    run.status = "failed";
    run.error = err instanceof Error ? err.message : String(err);
    appendLog(run, `Failed: ${run.error}`);
    await discardPreparedApplication().catch(() => {});
    finalizeRun(uid, run);
  }
}

/** Mark a run finished: clear the active-apply lock and schedule its eviction. */
function finalizeRun(uid: string, run: RunRecord): void {
  run.finishedAt = new Date().toISOString();
  applyRun = null;
  void persistRun(uid, run).catch(() => {});
  setTimeout(() => liveRuns.delete(run.id), 5 * 60 * 1000).unref?.();
}

/** Apply a submit outcome to a run. Returns true if the run reached a terminal
 *  state (or a CAPTCHA dead-end); false when it's paused awaiting a verification
 *  code (session stays open, run not finalized). */
function applySubmitOutcome(run: RunRecord, outcome: Awaited<ReturnType<typeof submitPreparedApplication>>): boolean {
  run.needsEmailCode = outcome.needsEmailCode;
  run.needsCaptcha = outcome.needsCaptcha;
  if (outcome.success) {
    run.status = "succeeded";
    run.summary = `Applied to ${run.jobTitle ?? "the role"}${run.company ? ` at ${run.company}` : ""}.`;
    return true;
  }
  if (outcome.needsEmailCode) {
    // Hold the session open for the user to enter the emailed code.
    run.status = "awaiting_code";
    return false;
  }
  // CAPTCHA or an unconfirmed submit: nothing more we can do automatically.
  run.status = "failed";
  run.error = outcome.error ?? "Submit did not confirm.";
  return true;
}

/** Approve a prepared application: submit it on the open session, mark applied. */
async function approveApplyRun(uid: string, run: RunRecord): Promise<RunRecord> {
  run.status = "running";
  appendLog(run, "Approved — submitting.");
  try {
    const outcome = await submitPreparedApplication(
      uid,
      run.applyLink ?? "",
      (msg) => appendLog(run, msg),
      (frame) => addPreview(run, frame),
    );
    if (!applySubmitOutcome(run, outcome)) {
      await persistRun(uid, run).catch(() => {}); // awaiting code — keep session + lock
      return run;
    }
  } catch (err) {
    run.status = "failed";
    run.error = err instanceof Error ? err.message : String(err);
    appendLog(run, `Failed: ${run.error}`);
    await discardPreparedApplication().catch(() => {});
  }
  finalizeRun(uid, run);
  return run;
}

/** Enter a user-supplied verification code on the held-open session. */
async function submitCodeRun(uid: string, run: RunRecord, code: string): Promise<RunRecord> {
  run.status = "running";
  appendLog(run, "Submitting verification code…");
  try {
    const outcome = await submitApplicationCode(
      uid,
      run.applyLink ?? "",
      code,
      (msg) => appendLog(run, msg),
      (frame) => addPreview(run, frame),
    );
    if (!applySubmitOutcome(run, outcome)) {
      // Still awaiting (wrong/expired code) — keep the session open for a retry.
      run.status = "awaiting_code";
      await persistRun(uid, run).catch(() => {});
      return run;
    }
  } catch (err) {
    run.status = "failed";
    run.error = err instanceof Error ? err.message : String(err);
    appendLog(run, `Failed: ${run.error}`);
    await discardPreparedApplication().catch(() => {});
  }
  finalizeRun(uid, run);
  return run;
}

/** Discard a prepared application: close the browser without submitting. */
async function discardApplyRun(uid: string, run: RunRecord): Promise<RunRecord> {
  await discardPreparedApplication((msg) => appendLog(run, msg)).catch(() => {});
  run.status = "cancelled";
  run.finishedAt = new Date().toISOString();
  applyRun = null;
  await persistRun(uid, run).catch(() => {});
  setTimeout(() => liveRuns.delete(run.id), 5 * 60 * 1000).unref?.();
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
      if (!isLlmConfigured()) {
        sendJson(res, 503, {
          error: "Resume structuring needs an LLM configured (ANTHROPIC_API_KEY, or JOBSYNC_LLM_PROVIDER=openai + JOBSYNC_LLM_API_KEY).",
        });
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
        // Keep the ORIGINAL bytes so Auto-Apply can attach the real file to a
        // resume/CV upload field (the temp dir below is deleted in `finally`).
        await writeResumeBlob(base64, filename, uid);
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

    // GET /api/runs/:id/live — near-live screenshot of the open apply browser.
    if (pathname.startsWith("/api/runs/") && pathname.endsWith("/live") && method === "GET") {
      const id = decodeURIComponent(pathname.slice("/api/runs/".length, -"/live".length));
      // Only the user who owns the in-flight apply session may peek at its browser.
      if (!applyRun || applyRun.id !== id || applyRun.uid !== uid) {
        res.writeHead(204, { "access-control-allow-origin": "*", "cache-control": "no-store" });
        res.end();
        return true;
      }
      const framePath = await captureLiveFrame();
      const shot = framePath ? await screenshotToData(framePath) : {};
      res.writeHead(shot.base64 || shot.url ? 200 : 204, {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(shot));
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

    // POST /api/runs/:id/approve | /discard — Auto-Apply approval gate.
    if (pathname.startsWith("/api/runs/") && method === "POST") {
      const rest = pathname.slice("/api/runs/".length);
      const slash = rest.lastIndexOf("/");
      const action = slash >= 0 ? rest.slice(slash + 1) : "";
      const id = decodeURIComponent(slash >= 0 ? rest.slice(0, slash) : rest);
      // Enter a verification code on a run paused at an emailed-code gate.
      if (action === "code") {
        const run = liveRuns.get(id);
        if (!run || run.agent !== "auto-apply") {
          sendJson(res, 404, { error: "No live application found for this run." });
          return true;
        }
        if (!applyRun || applyRun.id !== id || applyRun.uid !== uid || run.status !== "awaiting_code") {
          sendJson(res, 409, { error: "This application is not awaiting a verification code." });
          return true;
        }
        const body = await readJsonBody(req);
        const code = String(body.code ?? "").trim();
        if (!code) {
          sendJson(res, 400, { error: "code is required" });
          return true;
        }
        const updated = await submitCodeRun(uid, run, code);
        sendJson(res, 200, { run: updated });
        return true;
      }

      // Supply answers to questions the agent couldn't fill from the profile. They're
      // saved to per-user Q&A memory and the application is re-prepared with them.
      if (action === "answers") {
        const run = liveRuns.get(id);
        if (!run || run.agent !== "auto-apply") {
          sendJson(res, 404, { error: "No live application found for this run." });
          return true;
        }
        if (!applyRun || applyRun.id !== id || applyRun.uid !== uid || run.status !== "awaiting_input") {
          sendJson(res, 409, { error: "This application is not awaiting your input." });
          return true;
        }
        const body = await readJsonBody(req);
        const raw = Array.isArray(body.answers) ? body.answers : [];
        const answers = raw
          .map((a) => ({
            label: String((a as Record<string, unknown>).label ?? "").trim(),
            value: String((a as Record<string, unknown>).value ?? "").trim(),
          }))
          .filter((a) => a.label && a.value);
        if (answers.length === 0) {
          sendJson(res, 400, { error: "At least one answer (label + value) is required." });
          return true;
        }
        await rememberAnswers(answers, uid);
        appendLog(run, `Saved ${answers.length} answer(s) to your profile memory.`);
        await reprepareAfterAnswers(uid, run);
        sendJson(res, 200, { run });
        return true;
      }

      if (action === "approve" || action === "discard" || action === "accept-all" || action === "tweak" || action === "edit") {
        const run = liveRuns.get(id);
        if (!run || run.agent !== "auto-apply") {
          sendJson(res, 404, { error: "No live application found for this run." });
          return true;
        }
        if (!applyRun || applyRun.id !== id || applyRun.uid !== uid) {
          sendJson(res, 409, { error: "This application is no longer awaiting approval." });
          return true;
        }
        if (run.status !== "awaiting_approval") {
          sendJson(res, 409, { error: `Run is ${run.status}, not awaiting approval.` });
          return true;
        }

        // Rewrite (tweak) or overwrite (edit) one proposed answer, then return the
        // updated row so the console re-renders it. Run stays awaiting approval.
        if (action === "tweak" || action === "edit") {
          const body = await readJsonBody(req);
          const selector = String(body.selector ?? "");
          if (!selector) {
            sendJson(res, 400, { error: "selector is required" });
            return true;
          }
          try {
            const result =
              action === "tweak"
                ? await tweakAnswer(uid, run.applyLink ?? "", selector, String(body.transform ?? "humanize"))
                : editAnswer(selector, String(body.value ?? ""));
            // Reflect the new value in the run's proposed list.
            const row = run.proposed?.filled.find((f) => f.selector === selector);
            if (row) row.value = result.value;
            appendLog(run, `${action === "tweak" ? "Tweaked" : "Edited"} answer for "${row?.label ?? selector}".`);
            void persistRun(uid, run).catch(() => {});
            sendJson(res, 200, { run, field: row });
          } catch (err) {
            sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
          }
          return true;
        }

        // "Accept All" is a one-click submit of the prepared draft (same as approve).
        const updated = action === "discard" ? await discardApplyRun(uid, run) : await approveApplyRun(uid, run);
        sendJson(res, 200, { run: updated });
        return true;
      }
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
        const applyLink = typeof params.applyLink === "string" ? params.applyLink.trim() : "";
        if (!applyLink) {
          sendJson(res, 400, { error: "applyLink is required to auto-apply." });
          return true;
        }
        // Lever postings gate submission behind a CAPTCHA puzzle the agent can't
        // clear yet (tracked on GitHub). Refuse rather than burn a doomed run.
        if (detectAts(applyLink) === "lever") {
          sendJson(res, 422, {
            error:
              "Auto-Apply is disabled for Lever postings — they're protected by a CAPTCHA the agent can't solve yet. Open the apply link and submit manually.",
          });
          return true;
        }
        if (applyRun) {
          sendJson(res, 409, {
            error: "An application is already being prepared. Approve or discard it before starting another.",
          });
          return true;
        }
        const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
        const run = startApplyRun(
          uid,
          {
            applyLink,
            jobId: str(params.jobId),
            company: str(params.company),
            jobTitle: str(params.jobTitle),
          },
          {
            autonomous: params.autonomous === true,
            meta: {
              location: str(params.location),
              datePosted: str(params.datePosted),
              industry: str(params.industry),
              tags: str(params.tags),
              fitScore: str(params.fitScore),
            },
          },
        );
        sendJson(res, 202, { run });
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
