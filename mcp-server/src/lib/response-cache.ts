// TTL cache for expensive, idempotent MCP tool responses (fetch_*, link
// verification, classification). Backed by the active StorageAdapter so it
// persists across Cloud Run cold starts. Local installs get the same behavior
// via SQLite.

import { createHash } from "node:crypto";
import { getStorageConfig } from "../config.js";
import { getStore } from "./store/index.js";

/** Stable cache key from a tool name + its arguments. */
export function cacheKey(tool: string, args: unknown): string {
  const hash = createHash("sha256")
    .update(JSON.stringify(args ?? {}))
    .digest("hex")
    .slice(0, 32);
  return `${tool}:${hash}`;
}

/**
 * Run `fn` with its JSON result cached under `key`. On a hit within the TTL the
 * cached value is parsed and returned without invoking `fn`. `ttlSeconds`
 * defaults to the configured `responseCacheTtlHours`.
 *
 * Cache failures (e.g. Firestore unreachable) never block the call — they log
 * and fall through to a live `fn()`.
 */
export async function withCache<T>(
  key: string,
  fn: () => Promise<T>,
  ttlSeconds?: number,
): Promise<T> {
  const ttl = ttlSeconds ?? getStorageConfig().responseCacheTtlHours * 3600;
  let store;
  try {
    store = await getStore();
    const hit = await store.responseCache.get(key);
    if (hit !== null) {
      return JSON.parse(hit) as T;
    }
  } catch (err) {
    console.error(`response-cache read failed for ${key}:`, err);
  }

  const value = await fn();

  try {
    if (store) await store.responseCache.set(key, JSON.stringify(value), ttl);
  } catch (err) {
    console.error(`response-cache write failed for ${key}:`, err);
  }
  return value;
}

/** Delete expired response-cache entries. Returns the number removed. */
export async function pruneResponseCache(): Promise<number> {
  return (await getStore()).responseCache.prune();
}
