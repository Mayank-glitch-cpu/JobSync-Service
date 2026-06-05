// Hybrid dedup: a cache of seen job URLs. The MCP tool layer falls back to
// airtable_list_recent_jobs on a miss — this module only handles the cache half.
//
// The actual storage lives behind the StorageAdapter (see lib/store/): SQLite
// locally, Firestore in the cloud. This module keeps the original public API so
// cache-tools.ts and other callers are unchanged.

import { getStore } from "./store/index.js";
export { hashUrl } from "./store/local.js";
export type { SeenJob } from "./store/types.js";

export async function isSeen(applyLink: string) {
  return (await getStore()).seenJobs.isSeen(applyLink);
}

export async function markSeen(job: {
  applyLink: string;
  company: string;
  positionTitle: string;
}): Promise<void> {
  return (await getStore()).seenJobs.markSeen(job);
}

export async function markSeenBatch(
  jobs: Array<{ applyLink: string; company: string; positionTitle: string }>,
): Promise<number> {
  return (await getStore()).seenJobs.markSeenBatch(jobs);
}

export async function pruneOlderThan(days: number): Promise<number> {
  return (await getStore()).seenJobs.pruneOlderThan(days);
}

export async function cacheSize(): Promise<number> {
  return (await getStore()).seenJobs.size();
}
