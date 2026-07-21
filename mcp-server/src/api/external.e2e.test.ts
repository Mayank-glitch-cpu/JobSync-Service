// HTTP-level contract check for the External Agent API's profile tier: the
// routes another app calls to create a JobSync search profile for one of its
// users before kicking off /api/external/search.
//
// The resume-ingestion branch needs an LLM (structureResume), so it is covered
// by the 503 guard here; the metadata + roles branches run for real against a
// temp profile dir.

import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let dir: string;
let server: Server;
let base: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "external-e2e-"));
  process.env.JOBSYNC_PROFILE_DIR = dir;
  const { handleExternalApi } = await import("./external.js");
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!(await handleExternalApi(req, res, url))) res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  delete process.env.JOBSYNC_PROFILE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /api/external/profile", () => {
  it("rejects a request without a uid", async () => {
    const res = await post("/api/external/profile", { personal: { firstName: "Ada" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/uid is required/);
  });

  it("rejects a request with nothing to write", async () => {
    const res = await post("/api/external/profile", { uid: "u-empty" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Nothing to write/);
  });

  it("stores personal metadata and explicit roles, and reads them back", async () => {
    const res = await post("/api/external/profile", {
      uid: "u-1",
      personal: {
        firstName: "Ada",
        last_name: "Lovelace", // snake_case alias
        email: "ada@example.com",
        workAuthorization: "US Citizen",
        requiresSponsorship: false,
      },
      roles: ["Backend Engineer", "ML Engineer"],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profile.personal.firstName).toBe("Ada");
    expect(body.profile.personal.lastName).toBe("Lovelace");
    expect(body.profile.personal.requiresSponsorship).toBe(false);
    expect(body.profile.activeRoles).toContain("ML Engineer");
    expect(body.profile.hasResume).toBe(false);
    expect(body.next).toContain("/api/external/search");

    const read = await fetch(`${base}/api/external/profile?uid=u-1`);
    expect(read.status).toBe(200);
    expect((await read.json()).profile.personal.email).toBe("ada@example.com");
  });

  it("merges a later partial metadata update", async () => {
    const res = await post("/api/external/profile", { uid: "u-1", personal: { phone: "+1-555-0100" } });
    const body = await res.json();
    expect(body.profile.personal.phone).toBe("+1-555-0100");
    expect(body.profile.personal.firstName).toBe("Ada"); // preserved
  });

  it("accepts flat metadata alongside uid (no `personal` wrapper)", async () => {
    const res = await post("/api/external/profile", { uid: "u-2", first_name: "Grace", country: "USA" });
    expect(res.status).toBe(200);
    expect((await res.json()).profile.personal.firstName).toBe("Grace");
  });

  it("503s on a resume upload when no LLM is configured", async () => {
    const hadKey = process.env.ANTHROPIC_API_KEY;
    const hadLlmKey = process.env.JOBSYNC_LLM_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.JOBSYNC_LLM_API_KEY;
    try {
      const res = await post("/api/external/profile", {
        uid: "u-3",
        resume: { filename: "cv.txt", base64: Buffer.from("hello").toString("base64") },
      });
      expect(res.status).toBe(503);
      expect((await res.json()).error).toMatch(/LLM/);
    } finally {
      if (hadKey) process.env.ANTHROPIC_API_KEY = hadKey;
      if (hadLlmKey) process.env.JOBSYNC_LLM_API_KEY = hadLlmKey;
    }
  });

  it("requires a uid on the read route and rejects other methods", async () => {
    expect((await fetch(`${base}/api/external/profile`)).status).toBe(400);
    expect((await fetch(`${base}/api/external/profile`, { method: "DELETE" })).status).toBe(405);
  });
});
