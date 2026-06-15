import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FixtureStore,
  fixtureKey,
  makeFixtureFetch,
  isAtsUrl,
} from "./fixture-fetch.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fixtures-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A fake upstream fetch that counts calls and returns canned JSON. */
function fakeFetch(bodyByUrl: Record<string, { status?: number; body: string }>) {
  const calls: string[] = [];
  const fn = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(`${(init?.method ?? "GET").toUpperCase()} ${url}`);
    const canned = bodyByUrl[url] ?? { status: 200, body: "{}" };
    return new Response(canned.body, {
      status: canned.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fn, calls };
}

describe("fixtureKey", () => {
  it("ignores body for GET, includes a body hash for non-GET", () => {
    expect(fixtureKey("get", "https://x/y")).toBe("GET https://x/y");
    const a = fixtureKey("POST", "https://x/y", '{"offset":0}');
    const b = fixtureKey("POST", "https://x/y", '{"offset":20}');
    expect(a).not.toBe(b);
    expect(a.startsWith("POST https://x/y #")).toBe(true);
  });
});

describe("isAtsUrl", () => {
  it("matches the four ATS hosts and nothing else", () => {
    expect(isAtsUrl("https://boards-api.greenhouse.io/v1/boards/stripe/jobs")).toBe(true);
    expect(isAtsUrl("https://api.lever.co/v0/postings/ramp")).toBe(true);
    expect(isAtsUrl("https://api.ashbyhq.com/posting-api/job-board/openai")).toBe(true);
    expect(isAtsUrl("https://nvidia.wd5.myworkdayjobs.com/x")).toBe(true);
    expect(isAtsUrl("https://example.com/jobs")).toBe(false);
  });
});

describe("record mode", () => {
  it("persists the upstream response and returns it unchanged", async () => {
    const store = new FixtureStore(dir);
    const url = "https://boards-api.greenhouse.io/v1/boards/stripe/jobs";
    const { fn, calls } = fakeFetch({ [url]: { body: '{"jobs":[1,2]}' } });
    const fetchFx = makeFixtureFetch({ store, mode: "record", realFetch: fn });

    const res = await fetchFx(url);
    expect(await res.text()).toBe('{"jobs":[1,2]}');
    expect(calls).toHaveLength(1);
    expect(store.size).toBe(1);
    expect(store.has(fixtureKey("GET", url))).toBe(true);
  });
});

describe("replay mode", () => {
  it("serves the recorded response without calling upstream", async () => {
    const url = "https://api.lever.co/v0/postings/ramp?mode=json";
    const store = new FixtureStore(dir);
    // First record.
    const rec = fakeFetch({ [url]: { body: '[{"id":"a"}]' } });
    await makeFixtureFetch({ store, mode: "record", realFetch: rec.fn })(url);

    // New store from the same dir (proves it persisted), replay with a fetch that throws.
    const store2 = new FixtureStore(dir);
    const failFetch = (async () => {
      throw new Error("network must not be hit in replay");
    }) as typeof fetch;
    const replay = makeFixtureFetch({ store: store2, mode: "replay", realFetch: failFetch });

    const res = await replay(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('[{"id":"a"}]');
  });

  it("throws on a miss in strict replay mode", async () => {
    const store = new FixtureStore(dir);
    const replay = makeFixtureFetch({ store, mode: "replay", realFetch: fakeFetch({}).fn });
    await expect(replay("https://api.ashbyhq.com/posting-api/job-board/openai")).rejects.toThrow(
      /No recorded response/,
    );
  });

  it("falls back to upstream on a miss in replay-passthrough mode", async () => {
    const store = new FixtureStore(dir);
    const url = "https://api.ashbyhq.com/posting-api/job-board/openai";
    const { fn, calls } = fakeFetch({ [url]: { body: '{"jobs":[]}' } });
    const fetchFx = makeFixtureFetch({ store, mode: "replay-passthrough", realFetch: fn });

    const res = await fetchFx(url);
    expect(await res.text()).toBe('{"jobs":[]}');
    expect(calls).toHaveLength(1);
  });
});

describe("interception scope", () => {
  it("passes non-intercepted URLs straight through without recording", async () => {
    const store = new FixtureStore(dir);
    const url = "https://example.com/not-ats";
    const { fn, calls } = fakeFetch({ [url]: { body: "ok" } });
    const fetchFx = makeFixtureFetch({
      store,
      mode: "record",
      realFetch: fn,
      shouldIntercept: isAtsUrl,
    });

    await fetchFx(url);
    expect(calls).toHaveLength(1);
    expect(store.size).toBe(0); // not recorded — outside ATS scope
  });
});

describe("non-GET keying (Workday pagination)", () => {
  it("records distinct fixtures per request body", async () => {
    const store = new FixtureStore(dir);
    const url = "https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/External/jobs";
    const { fn } = fakeFetch({ [url]: { body: '{"jobPostings":[],"total":0}' } });
    const fetchFx = makeFixtureFetch({ store, mode: "record", realFetch: fn });

    await fetchFx(url, { method: "POST", body: '{"offset":0}' });
    await fetchFx(url, { method: "POST", body: '{"offset":20}' });
    expect(store.size).toBe(2);
  });
});
