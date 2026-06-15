// Record/replay HTTP interceptor for the eval harness.
//
// The Search agent's discovery (fast-path.ts) and link verification
// (link-check-tools.ts) both call the global `fetch` against live ATS APIs
// (Greenhouse/Lever/Ashby/Workday). Live boards change hourly, so an eval that
// asks "did it find RECENT jobs / drop DEAD links" is ungradable against
// production. This module snapshots a real day's responses and replays them, so
// recency/liveness ground truth is exact and tasks are re-runnable forever.
//
// It works by wrapping globalThis.fetch — no changes to the fetchers or the
// verifier. Three modes:
//   record    — call real fetch, persist the response, return it
//   replay    — serve the recorded response; a miss throws (deterministic eval)
//   replay+passthrough — serve recorded; on a miss fall back to real fetch
//
// A separate real HTTP server is intentionally NOT needed for the search path:
// interception is faster and hermetic. The browser-driven auto-apply path
// (Phase 4) does need a real server because patchright loads real URLs — that
// wraps the same FixtureStore.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type FixtureMode = "record" | "replay" | "replay-passthrough";

export interface FixtureRecord {
  method: string;
  url: string;
  /** Present only for non-GET (e.g. Workday POST pagination bodies). */
  requestBody?: string;
  status: number;
  statusText: string;
  /** Minimal headers needed to reconstruct a usable Response. */
  headers: Record<string, string>;
  /** Response body as text (ATS APIs are JSON; pages are HTML — both are text). */
  body: string;
  recordedAt: string;
}

type Manifest = Record<string, string>; // fixtureKey -> relative filename

// `RequestInfo` isn't in this project's TS lib; derive the fetch arg types from
// the global fetch signature so we stay in lockstep with whatever lib is active.
type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

const MANIFEST_NAME = "manifest.json";

/** Stable key for a request: method + url + (body hash for non-GET). */
export function fixtureKey(method: string, url: string, body?: string): string {
  const m = method.toUpperCase();
  const base = `${m} ${url}`;
  if (m === "GET" || !body) return base;
  const h = createHash("sha1").update(body).digest("hex").slice(0, 12);
  return `${base} #${h}`;
}

/** Filesystem-safe filename for a fixture key. */
function keyToFilename(key: string): string {
  return createHash("sha1").update(key).digest("hex") + ".json";
}

/** Persistent store of recorded responses under a directory. */
export class FixtureStore {
  private manifest: Manifest;

  constructor(public readonly dir: string) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const manifestPath = join(dir, MANIFEST_NAME);
    this.manifest = existsSync(manifestPath)
      ? (JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest)
      : {};
  }

  has(key: string): boolean {
    return key in this.manifest;
  }

  get(key: string): FixtureRecord | null {
    const file = this.manifest[key];
    if (!file) return null;
    const path = join(this.dir, file);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as FixtureRecord;
  }

  put(key: string, record: FixtureRecord): void {
    const file = keyToFilename(key);
    writeFileSync(join(this.dir, file), JSON.stringify(record, null, 2));
    this.manifest[key] = file;
    this.flush();
  }

  /** Number of recorded entries. */
  get size(): number {
    return Object.keys(this.manifest).length;
  }

  private flush(): void {
    writeFileSync(join(this.dir, MANIFEST_NAME), JSON.stringify(this.manifest, null, 2));
  }
}

/** Reconstruct a Response from a stored record. */
function recordToResponse(rec: FixtureRecord): Response {
  return new Response(rec.body, {
    status: rec.status,
    statusText: rec.statusText,
    headers: rec.headers,
  });
}

/** Extract the request method/url/body from fetch() args. */
async function describeRequest(
  input: FetchInput,
  init?: FetchInit,
): Promise<{ method: string; url: string; body?: string }> {
  if (input instanceof Request) {
    const method = input.method ?? "GET";
    const body = method.toUpperCase() === "GET" ? undefined : await input.clone().text().catch(() => undefined);
    return { method, url: input.url, body };
  }
  const url = typeof input === "string" ? input : input.toString();
  const method = (init?.method ?? "GET").toUpperCase();
  let body: string | undefined;
  if (method !== "GET" && init?.body != null) {
    body = typeof init.body === "string" ? init.body : undefined;
  }
  return { method, url, body };
}

const HEADER_ALLOWLIST = ["content-type", "content-language"];

function pickHeaders(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of HEADER_ALLOWLIST) {
    const v = res.headers.get(h);
    if (v) out[h] = v;
  }
  return out;
}

export interface FixtureFetchOptions {
  store: FixtureStore;
  mode: FixtureMode;
  /** The fetch to delegate to when recording or passing through. Defaults to the
   *  global fetch captured at install time. */
  realFetch?: typeof fetch;
  /** Only intercept URLs matching this predicate; others always passthrough. */
  shouldIntercept?: (url: string) => boolean;
}

/**
 * Build a fetch function backed by the fixture store. Pure (no globals touched) —
 * useful for tests and for the recorder. Use installFixtureFetch() to patch the
 * global.
 */
export function makeFixtureFetch(opts: FixtureFetchOptions): typeof fetch {
  const real = opts.realFetch ?? fetch;
  const intercept = opts.shouldIntercept ?? (() => true);

  const fixtureFetch = (async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const { method, url, body } = await describeRequest(input, init);

    if (!intercept(url)) return real(input, init);

    const key = fixtureKey(method, url, body);

    if (opts.mode === "record") {
      const res = await real(input, init);
      const text = await res.clone().text();
      opts.store.put(key, {
        method,
        url,
        ...(body !== undefined ? { requestBody: body } : {}),
        status: res.status,
        statusText: res.statusText,
        headers: pickHeaders(res),
        body: text,
        recordedAt: new Date().toISOString(),
      });
      return res;
    }

    const hit = opts.store.get(key);
    if (hit) return recordToResponse(hit);

    if (opts.mode === "replay-passthrough") return real(input, init);

    throw new Error(
      `[fixture-fetch] No recorded response for ${key} (mode=replay). ` +
        `Record fixtures first or use replay-passthrough.`,
    );
  }) as typeof fetch;

  return fixtureFetch;
}

let originalFetch: typeof fetch | null = null;

/** Patch globalThis.fetch with a fixture-backed fetch. Returns a restore fn. */
export function installFixtureFetch(opts: Omit<FixtureFetchOptions, "realFetch">): () => void {
  if (originalFetch) throw new Error("[fixture-fetch] already installed — restore first.");
  originalFetch = globalThis.fetch;
  const patched = makeFixtureFetch({ ...opts, realFetch: originalFetch });
  globalThis.fetch = patched;
  return () => {
    if (originalFetch) globalThis.fetch = originalFetch;
    originalFetch = null;
  };
}

/** ATS hosts the search agent talks to — the default interception scope. */
export function isAtsUrl(url: string): boolean {
  return /(?:greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com)/i.test(url);
}

/**
 * Install the fixture fetch from environment, if configured. The eval container
 * sets JOBSYNC_FIXTURE_DIR (+ optional JOBSYNC_FIXTURE_MODE, default "replay")
 * and this becomes active process-wide. No-op in production (vars unset).
 * Returns a restore fn, or null when fixtures are not configured.
 */
export function installFixtureFetchFromEnv(): (() => void) | null {
  const dir = process.env.JOBSYNC_FIXTURE_DIR;
  if (!dir) return null;
  const mode = (process.env.JOBSYNC_FIXTURE_MODE as FixtureMode) ?? "replay";
  const store = new FixtureStore(dir);
  return installFixtureFetch({ store, mode, shouldIntercept: isAtsUrl });
}
