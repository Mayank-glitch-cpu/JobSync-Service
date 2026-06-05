// Storage abstraction. Two backends implement this interface:
//   - local: SQLite + ~/.jobsync files (default for stdio installs)
//   - firestore: GCP Firestore (survives Cloud Run's ephemeral filesystem)
// The lib modules (cache, pipeline, profile, portals, response-cache) call the
// adapter rather than touching the filesystem directly, so the same code path
// works locally and in the cloud.

export interface SeenJob {
  urlHash: string;
  applyLink: string;
  company: string;
  positionTitle: string;
  seenAt: string;
}

/** Dedup cache of job URLs already processed. */
export interface SeenJobsStore {
  isSeen(applyLink: string): Promise<SeenJob | null>;
  markSeen(job: {
    applyLink: string;
    company: string;
    positionTitle: string;
  }): Promise<void>;
  markSeenBatch(
    jobs: Array<{ applyLink: string; company: string; positionTitle: string }>,
  ): Promise<number>;
  pruneOlderThan(days: number): Promise<number>;
  size(): Promise<number>;
}

/** TTL-keyed cache for expensive, idempotent MCP tool responses. */
export interface ResponseCacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  prune(): Promise<number>;
}

/**
 * Namespaced key-value store for app state that was previously plain files:
 * pipeline (TSV body), portals (yml body), profile files (markdown/json).
 * Bodies are opaque strings — each lib module serializes/parses its own format.
 */
export interface DocStore {
  readDoc(namespace: string, id: string): Promise<string | null>;
  writeDoc(namespace: string, id: string, body: string): Promise<void>;
  deleteDoc(namespace: string, id: string): Promise<void>;
  listDocs(namespace: string): Promise<string[]>;
}

export interface StorageAdapter {
  readonly backend: "local" | "firestore";
  readonly seenJobs: SeenJobsStore;
  readonly responseCache: ResponseCacheStore;
  readonly docs: DocStore;
}
