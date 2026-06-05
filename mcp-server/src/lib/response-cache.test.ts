import { describe, it, expect, beforeEach, vi } from "vitest";
import type { StorageAdapter } from "./store/types.js";

// Isolate withCache from any real backend: mock the store with an in-memory
// response cache. This also avoids loading the local SQLite backend (node:sqlite
// doesn't resolve under vite-node).
const mem = new Map<string, { value: string; expiresAt: number }>();

const fakeAdapter = {
  backend: "local",
  responseCache: {
    async get(key: string) {
      const row = mem.get(key);
      if (!row) return null;
      if (row.expiresAt <= Date.now()) return null;
      return row.value;
    },
    async set(key: string, value: string, ttlSeconds: number) {
      mem.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    },
    async prune() {
      let n = 0;
      for (const [k, v] of mem) if (v.expiresAt <= Date.now()) (mem.delete(k), n++);
      return n;
    },
  },
} as unknown as StorageAdapter;

vi.mock("./store/index.js", () => ({
  getStore: async () => fakeAdapter,
}));

const { cacheKey, withCache } = await import("./response-cache.js");

beforeEach(() => mem.clear());

describe("cacheKey", () => {
  it("is stable for equal args and differs for different tool/args", () => {
    expect(cacheKey("fetch_ashby_jobs", "anthropic")).toBe(
      cacheKey("fetch_ashby_jobs", "anthropic"),
    );
    expect(cacheKey("fetch_ashby_jobs", "anthropic")).not.toBe(
      cacheKey("fetch_ashby_jobs", "openai"),
    );
    expect(cacheKey("fetch_ashby_jobs", "anthropic")).not.toBe(
      cacheKey("fetch_lever_jobs", "anthropic"),
    );
  });
});

describe("withCache", () => {
  it("serves a cached value without re-invoking fn within the TTL", async () => {
    const key = cacheKey("test_tool", { a: 1 });
    let calls = 0;
    const fn = async () => {
      calls++;
      return { value: 42 };
    };

    const first = await withCache(key, fn, 60);
    const second = await withCache(key, fn, 60);

    expect(first).toEqual({ value: 42 });
    expect(second).toEqual({ value: 42 });
    expect(calls).toBe(1); // second call hit the cache
  });

  it("re-invokes fn once the entry has expired", async () => {
    const key = cacheKey("test_tool_expiring", { a: 2 });
    let calls = 0;
    const fn = async () => {
      calls++;
      return calls;
    };

    // ttl 0 → expiresAt == now, so the next read is always a miss.
    expect(await withCache(key, fn, 0)).toBe(1);
    expect(await withCache(key, fn, 0)).toBe(2);
    expect(calls).toBe(2);
  });

  it("falls through to fn when the cache read throws", async () => {
    const key = cacheKey("test_tool_err", { a: 3 });
    const spy = vi.spyOn(fakeAdapter.responseCache, "get").mockRejectedValueOnce(
      new Error("backend down"),
    );

    const result = await withCache(key, async () => "live", 60);
    expect(result).toBe("live");
    spy.mockRestore();
  });
});
