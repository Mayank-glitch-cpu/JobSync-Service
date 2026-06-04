#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createJobSyncServer } from "./server.js";

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

const httpServer = createServer(async (req, res) => {
  if (!req.url) {
    sendJson(res, 400, { error: "missing URL" });
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  if (req.method === "GET" && url.pathname === "/healthz") {
    sendJson(res, 200, { ok: true, service: "jobsync-mcp" });
    return;
  }

  if (url.pathname !== "/mcp") {
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
  console.error(`jobsync-mcp HTTP transport listening on :${port}/mcp (${authMode})`);
});
