#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createJobSyncServer } from "./server.js";
import { inspectForm, fillAndSubmit, saveApplyDraft, saveFormState } from "./lib/browser-apply.js";
import { fillFields } from "./lib/ai-fill.js";
import { screenshotToData } from "./lib/gcs.js";
import { handleDashboardApi } from "./api/dashboard.js";
import { handleExternalApi } from "./api/external.js";
import { handleMutuApi } from "./api/mutu.js";

// Static dashboard build (the SPA). In the Docker image the dashboard's dist is
// copied next to this bundle as ./public; override with JOBSYNC_PUBLIC_DIR.
const PUBLIC_DIR = resolve(
  process.env.JOBSYNC_PUBLIC_DIR ?? fileURLToPath(new URL("./public", import.meta.url)),
);

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/**
 * Serve the dashboard SPA: a real file if it exists (hashed assets get long
 * cache), otherwise fall back to index.html so client-side routes resolve.
 * Returns false if there's no build to serve.
 */
function serveStatic(res: ServerResponse, pathname: string): boolean {
  if (!existsSync(PUBLIC_DIR)) return false;
  // Resolve the request under PUBLIC_DIR; `resolve` normalizes separators and
  // collapses any `..`, and the prefix check blocks path traversal.
  const rel = decodeURIComponent(pathname).replace(/^[/\\]+/, "");
  let filePath = resolve(PUBLIC_DIR, rel);
  const indexHtml = join(PUBLIC_DIR, "index.html");
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + sep)) filePath = indexHtml;

  const isFile = existsSync(filePath) && extname(filePath) !== "";
  if (!isFile) filePath = indexHtml; // SPA fallback
  if (!existsSync(filePath)) return false;

  const ext = extname(filePath);
  const cacheable = ext !== ".html" && rel.startsWith("assets/");
  res.writeHead(200, {
    "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
    "cache-control": cacheable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  res.end(readFileSync(filePath));
  return true;
}

const port = Number(process.env.PORT ?? 3000);
const bearerToken = process.env.JOBSYNC_REMOTE_BEARER_TOKEN;

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type, mcp-session-id",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  });
  res.end(JSON.stringify(body));
}

function isAuthorized(req: IncomingMessage): boolean {
  if (!bearerToken) return true;
  return req.headers.authorization === `Bearer ${bearerToken}`;
}

async function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", (err) => {
      reject(err);
    });
  });
}

const getScreenshotData = screenshotToData;

export const httpServer = createServer(async (req, res) => {
  if (!req.url) {
    sendJson(res, 400, { error: "missing URL" });
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  const pathname = url.pathname;

  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  if (req.method === "GET" && pathname === "/healthz") {
    sendJson(res, 200, { ok: true, service: "jobsync-mcp" });
    return;
  }

  // External Agent API (/api/external/*): machine-to-machine, gated by the same
  // service bearer token as /api/auto-apply. Checked before the dashboard handler
  // since the dashboard owns the broader /api/ prefix.
  if (pathname.startsWith("/api/external/")) {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    if (await handleExternalApi(req, res, url)) {
      return;
    }
  }

  // Mutu integration API (/api/mutu/*): machine-to-machine surface for the Mutu
  // AI app (demographics, resume parsing, role synthesis, job retrieval). Same
  // service bearer token as /api/external. See docs/mutu-integration.md.
  if (pathname.startsWith("/api/mutu/")) {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    if (await handleMutuApi(req, res, url)) {
      return;
    }
  }

  // Dashboard API (/api/* except /api/auto-apply): Firebase-authenticated,
  // per-user. Returns true when it owns the route.
  if (await handleDashboardApi(req, res, pathname)) {
    return;
  }

  // Handle REST API Routing
  if (pathname.startsWith("/api/auto-apply")) {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }

    try {
      const body = await readJsonBody(req);

      if (pathname === "/api/auto-apply/inspect") {
        const { applyLink } = body;
        if (!applyLink) {
          sendJson(res, 400, { error: "missing applyLink" });
          return;
        }

        const result = await inspectForm(String(applyLink));
        const screenshot = await getScreenshotData(result.screenshotPath);
        sendJson(res, 200, {
          success: true,
          result,
          ...screenshot,
        });
        return;
      }

      if (pathname === "/api/auto-apply/fill") {
        const { fields, profile, company, jobTitle, applyLink } = body;
        if (!fields || !Array.isArray(fields)) {
          sendJson(res, 400, { error: "missing or invalid fields array" });
          return;
        }

        const personal = profile?.personal || {};
        const experience = profile?.experience || "";
        const skills = profile?.skills || "";
        const projects = profile?.projects || "";

        const fillResult = fillFields(
          fields,
          personal,
          company || "the company",
          jobTitle || "this role",
          experience,
          skills,
          projects
        );

        // If customAnswers is provided, merge them into instructions
        const instructions = [...fillResult.instructions];
        const unansweredFields = [...fillResult.unansweredFields];
        
        if (profile?.customAnswers) {
          const answers = profile.customAnswers as Record<string, string>;
          for (let i = unansweredFields.length - 1; i >= 0; i--) {
            const field = unansweredFields[i];
            if (!field) continue;
            const val = answers[field.selector] ?? answers[field.label];
            if (val !== undefined) {
              instructions.push({
                selector: field.selector,
                label: field.label,
                value: val,
                type: field.type,
                frameUrl: field.frameUrl,
              });
              unansweredFields.splice(i, 1);
            }
          }
        }

        if (applyLink) {
          saveApplyDraft(instructions, [], String(applyLink));
        }

        sendJson(res, 200, {
          success: true,
          instructions,
          unansweredFields,
          unfilledRequired: fillResult.unfilledRequired,
          essayPromptBlock: fillResult.essayPromptBlock,
        });
        return;
      }

      if (pathname === "/api/auto-apply/submit") {
        const { applyLink, fields, dryRun, resumeBase64, resumeFilename } = body;
        if (!applyLink) {
          sendJson(res, 400, { error: "missing applyLink" });
          return;
        }

        let tempDir: string | null = null;
        let tempFilePath: string | null = null;
        let effectiveFields = fields || [];

        try {
          if (resumeBase64 && resumeFilename) {
            tempDir = join(tmpdir(), `jobsync-resumes-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);
            mkdirSync(tempDir, { recursive: true });
            tempFilePath = join(tempDir, resumeFilename);
            writeFileSync(tempFilePath, Buffer.from(resumeBase64, "base64"));

            let fileFieldModified = false;
            effectiveFields = effectiveFields.map((f: any) => {
              if (f.type === "file" || /resume|cv/i.test(f.label || f.selector)) {
                fileFieldModified = true;
                return { ...f, value: tempFilePath, type: "file" };
              }
              return f;
            });

            // If no file instruction existed but we have a file, try to append it
            if (!fileFieldModified && fields) {
              effectiveFields.push({
                selector: 'input[type="file"]',
                label: "Resume",
                value: tempFilePath,
                type: "file",
              });
            }
          }

          const result = await fillAndSubmit(String(applyLink), effectiveFields, Boolean(dryRun));
          const screenshot = await getScreenshotData(result.screenshotPath);

          sendJson(res, 200, {
            success: result.success,
            result,
            ...screenshot,
          });
        } finally {
          if (tempFilePath && existsSync(tempFilePath)) {
            rmSync(tempFilePath, { force: true });
          }
          if (tempDir && existsSync(tempDir)) {
            rmSync(tempDir, { recursive: true, force: true });
          }
        }
        return;
      }

      if (pathname === "/api/auto-apply") {
        const { applyLink, company, jobTitle, dryRun, profile, resumeBase64, resumeFilename } = body;
        if (!applyLink) {
          sendJson(res, 400, { error: "missing applyLink" });
          return;
        }

        let tempDir: string | null = null;
        let tempFilePath: string | null = null;

        try {
          // Step 1: Inspect
          const inspectResult = await inspectForm(String(applyLink));
          const inspectScreenshot = await getScreenshotData(inspectResult.screenshotPath);

          // Step 2: Prepare resume if uploaded
          const personal = { ...(profile?.personal || {}) };
          if (resumeBase64 && resumeFilename) {
            tempDir = join(tmpdir(), `jobsync-resumes-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);
            mkdirSync(tempDir, { recursive: true });
            tempFilePath = join(tempDir, resumeFilename);
            writeFileSync(tempFilePath, Buffer.from(resumeBase64, "base64"));
            personal.resumePath = tempFilePath;
          }

          // Step 3: Fill/Map
          const fillResult = fillFields(
            inspectResult.fields,
            personal,
            company || "the company",
            jobTitle || "this role",
            profile?.experience || "",
            profile?.skills || "",
            profile?.projects || ""
          );

          const instructions = [...fillResult.instructions];
          const unansweredFields = [...fillResult.unansweredFields];

          // Merge customAnswers
          if (profile?.customAnswers) {
            const answers = profile.customAnswers as Record<string, string>;
            for (let i = unansweredFields.length - 1; i >= 0; i--) {
              const field = unansweredFields[i];
              if (!field) continue;
              const val = answers[field.selector] ?? answers[field.label];
              if (val !== undefined) {
                instructions.push({
                  selector: field.selector,
                  label: field.label,
                  value: val,
                  type: field.type,
                  frameUrl: field.frameUrl,
                });
                unansweredFields.splice(i, 1);
              }
            }
          }

          // Update resume path in instructions if we had one
          if (tempFilePath) {
            let resumeInstructionFound = false;
            for (let i = 0; i < instructions.length; i++) {
              const instr = instructions[i];
              if (instr && instr.type === "file") {
                instr.value = tempFilePath;
                resumeInstructionFound = true;
              }
            }
            if (!resumeInstructionFound) {
              instructions.push({
                selector: 'input[type="file"]',
                label: "Resume",
                value: tempFilePath,
                type: "file",
              });
            }
          }

          // Save state so required fields matching is active in fillAndSubmit
          const state = {
            url: String(applyLink),
            originalUrl: String(applyLink),
            atsHint: inspectResult.atsHint,
            fields: inspectResult.fields,
            timestamp: Date.now(),
            draftInstructions: instructions,
          };
          saveFormState(state);

          // Step 4: Submit if there are no unfilled required fields (or if it's a dry run)
          const unfilledRequired = unansweredFields.filter(f => f.required).map(f => f.label);
          if (unfilledRequired.length > 0 && !dryRun) {
            sendJson(res, 400, {
              success: false,
              error: "unfilled_required_fields",
              unfilledRequired,
              unansweredFields,
              instructions,
              inspectResult,
              inspectScreenshot,
            });
            return;
          }

          const submitResult = await fillAndSubmit(String(applyLink), instructions, Boolean(dryRun));
          const submitScreenshot = await getScreenshotData(submitResult.screenshotPath);

          sendJson(res, 200, {
            success: submitResult.success,
            inspectResult,
            inspectScreenshot,
            submitResult,
            submitScreenshot,
            instructions,
          });
        } finally {
          if (tempFilePath && existsSync(tempFilePath)) {
            rmSync(tempFilePath, { force: true });
          }
          if (tempDir && existsSync(tempDir)) {
            rmSync(tempDir, { recursive: true, force: true });
          }
        }
        return;
      }
    } catch (error) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
  }

  // Handle standard MCP SSE / HTTP Endpoint
  if (pathname !== "/mcp") {
    // Non-MCP, non-API request: serve the dashboard SPA if it's built in.
    if (req.method === "GET" && serveStatic(res, pathname)) return;
    sendJson(res, 404, { error: "not found" });
    return;
  }

  if (!isAuthorized(req)) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  try {
    const server = createJobSyncServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    if (!res.headersSent) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
});

httpServer.listen(port, () => {
  const authMode = bearerToken ? "bearer-token" : "authless";
  console.error(`jobsync-mcp HTTP transport listening on :${port} (${authMode})`);
});
