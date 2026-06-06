// Dashboard REST API (/api/* — distinct from the /api/auto-apply browser routes
// in http.ts). Every route except /api/config requires a valid Firebase ID token;
// the uid is taken from the verified token and all data is scoped to it, so users
// can only ever see their own pipeline and runs.

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { AuthError, requireUser, upsertUser, type AuthUser } from "../lib/firebase-auth.js";
import { getPipelineGrouped, updateStatuses, type ApplicationStatus } from "../lib/pipeline.js";
import { getStore } from "../lib/store/index.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
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

const AGENT_CATALOG = [
  {
    id: "search",
    name: "Search",
    description: "Find and rank jobs matching your profile, then add them to your pipeline.",
    status: "coming-soon",
  },
  {
    id: "auto-apply",
    name: "Auto-Apply",
    description: "Automatically fill and submit applications for jobs in your pipeline.",
    status: "coming-soon",
  },
];

interface RunRecord {
  id: string;
  agent: string;
  params: Record<string, unknown>;
  status: string;
  createdAt: string;
}

async function readRuns(uid: string): Promise<RunRecord[]> {
  const raw = await (await getStore()).docs.readDoc("runs", uid);
  return raw ? (JSON.parse(raw) as RunRecord[]) : [];
}

async function writeRuns(uid: string, runs: RunRecord[]): Promise<void> {
  await (await getStore()).docs.writeDoc("runs", uid, JSON.stringify(runs));
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
  // /api/auto-apply/* is handled separately in http.ts.
  if (pathname.startsWith("/api/auto-apply")) return false;

  const method = req.method ?? "GET";

  // Public: SPA bootstrap config.
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

  try {
    if (pathname === "/api/me" && method === "GET") {
      await upsertUser(user);
      sendJson(res, 200, { uid: user.uid, email: user.email });
      return true;
    }

    if (pathname === "/api/agents" && method === "GET") {
      sendJson(res, 200, { agents: AGENT_CATALOG });
      return true;
    }

    if (pathname === "/api/pipeline" && method === "GET") {
      const result = await getPipelineGrouped(undefined, user.uid);
      sendJson(res, 200, result);
      return true;
    }

    // PATCH /api/pipeline/:id  → update one tracked job's status/notes
    if (pathname.startsWith("/api/pipeline/") && method === "PATCH") {
      const id = decodeURIComponent(pathname.slice("/api/pipeline/".length));
      const body = await readJsonBody(req);
      const status = body.status as ApplicationStatus | undefined;
      if (!status) {
        sendJson(res, 400, { error: "status is required" });
        return true;
      }
      const result = await updateStatuses(
        [{ id, status, notes: body.notes as string | undefined }],
        user.uid,
      );
      sendJson(res, result.matched > 0 ? 200 : 404, result);
      return true;
    }

    if (pathname === "/api/runs" && method === "GET") {
      sendJson(res, 200, { runs: await readRuns(user.uid) });
      return true;
    }

    // POST /api/runs → record an agent-run request. Phase 1 only queues it;
    // the server-side agent runtime (Search/Auto-Apply) ships in Phase 2/3.
    if (pathname === "/api/runs" && method === "POST") {
      const body = await readJsonBody(req);
      const agent = String(body.agent ?? "");
      if (!AGENT_CATALOG.some((a) => a.id === agent)) {
        sendJson(res, 400, { error: `unknown agent: ${agent}` });
        return true;
      }
      const run: RunRecord = {
        id: randomUUID(),
        agent,
        params: (body.params as Record<string, unknown>) ?? {},
        status: "queued",
        createdAt: new Date().toISOString(),
      };
      const runs = await readRuns(user.uid);
      runs.unshift(run);
      await writeRuns(user.uid, runs.slice(0, 100));
      sendJson(res, 202, {
        run,
        message: "Queued. The agent runtime ships in the next release — your request is saved.",
      });
      return true;
    }

    sendJson(res, 404, { error: "not found" });
    return true;
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    return true;
  }
}
