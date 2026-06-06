// Per-run scope propagation. When the server runs an agent on behalf of a user,
// it sets the user's uid in this AsyncLocalStorage for the duration of the run.
// The per-user stores (pipeline, profile) read `currentScope()` so the existing
// tool handlers — which take no uid argument — automatically read/write the right
// user's data. Outside a run (MCP/stdio single-user path) there's no store set, so
// `currentScope()` returns undefined and callers fall back to "default".

import { AsyncLocalStorage } from "node:async_hooks";

interface RunScope {
  uid: string;
}

const storage = new AsyncLocalStorage<RunScope>();

/** Run `fn` with `uid` as the ambient scope (propagates through awaits). */
export function runWithScope<T>(uid: string, fn: () => Promise<T>): Promise<T> {
  return storage.run({ uid }, fn);
}

/** The current run's uid, or undefined when not inside a scoped run. */
export function currentScope(): string | undefined {
  return storage.getStore()?.uid;
}
