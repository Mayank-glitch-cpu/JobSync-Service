// Firestore storage backend. Persists across Cloud Run's ephemeral,
// scale-to-zero filesystem. Collections:
//   - seen_jobs:    doc id = url hash; dedup cache
//   - mcp_cache:    doc id = cache key; TTL via `expiresAt` (+ Firestore TTL policy)
//   - jobsync_docs: doc id = `${namespace}__${id}`; pipeline/profile/portals state
//
// The client is imported lazily (mirroring lib/gcs.ts) so a local install that
// never selects this backend doesn't pay the dependency cost.

import type { Firestore } from "@google-cloud/firestore";
import { hashUrl } from "./local.js";
import type { StorageAdapter, SeenJob } from "./types.js";

const SEEN_COLLECTION = "seen_jobs";
const CACHE_COLLECTION = "mcp_cache";
const DOCS_COLLECTION = "jobsync_docs";

let clientPromise: Promise<Firestore> | null = null;

function getClient(opts: { projectId?: string; databaseId?: string }): Promise<Firestore> {
  if (!clientPromise) {
    clientPromise = import("@google-cloud/firestore").then(({ Firestore: Ctor }) => {
      const settings: { projectId?: string; databaseId?: string } = {};
      if (opts.projectId) settings.projectId = opts.projectId;
      if (opts.databaseId) settings.databaseId = opts.databaseId;
      return new Ctor(settings);
    });
  }
  return clientPromise;
}

function docKey(namespace: string, id: string): string {
  return `${namespace}__${id}`;
}

export function createFirestoreAdapter(opts: {
  projectId?: string;
  databaseId?: string;
}): StorageAdapter {
  const db = () => getClient(opts);

  return {
    backend: "firestore",

    seenJobs: {
      async isSeen(applyLink) {
        const hash = hashUrl(applyLink);
        const snap = await (await db()).collection(SEEN_COLLECTION).doc(hash).get();
        if (!snap.exists) return null;
        return snap.data() as SeenJob;
      },

      async markSeen(job) {
        const hash = hashUrl(job.applyLink);
        await (await db())
          .collection(SEEN_COLLECTION)
          .doc(hash)
          .set({
            urlHash: hash,
            applyLink: job.applyLink,
            company: job.company,
            positionTitle: job.positionTitle,
            seenAt: new Date().toISOString(),
          });
      },

      async markSeenBatch(jobs) {
        const client = await db();
        const now = new Date().toISOString();
        // Firestore batches cap at 500 writes.
        for (let i = 0; i < jobs.length; i += 450) {
          const batch = client.batch();
          for (const r of jobs.slice(i, i + 450)) {
            const hash = hashUrl(r.applyLink);
            batch.set(client.collection(SEEN_COLLECTION).doc(hash), {
              urlHash: hash,
              applyLink: r.applyLink,
              company: r.company,
              positionTitle: r.positionTitle,
              seenAt: now,
            });
          }
          await batch.commit();
        }
        return jobs.length;
      },

      async pruneOlderThan(days) {
        const client = await db();
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        const snap = await client
          .collection(SEEN_COLLECTION)
          .where("seenAt", "<", cutoff)
          .get();
        let deleted = 0;
        for (let i = 0; i < snap.docs.length; i += 450) {
          const batch = client.batch();
          for (const d of snap.docs.slice(i, i + 450)) {
            batch.delete(d.ref);
            deleted++;
          }
          await batch.commit();
        }
        return deleted;
      },

      async size() {
        const snap = await (await db()).collection(SEEN_COLLECTION).count().get();
        return snap.data().count;
      },
    },

    responseCache: {
      async get(key) {
        const snap = await (await db()).collection(CACHE_COLLECTION).doc(key).get();
        if (!snap.exists) return null;
        const data = snap.data() as { value: string; expiresAt?: { toMillis(): number } };
        const expiresMs = data.expiresAt?.toMillis?.() ?? 0;
        if (expiresMs <= Date.now()) return null;
        return data.value;
      },

      async set(key, value, ttlSeconds) {
        const client = await db();
        const { Timestamp } = await import("@google-cloud/firestore");
        await client
          .collection(CACHE_COLLECTION)
          .doc(key)
          .set({
            value,
            expiresAt: Timestamp.fromMillis(Date.now() + ttlSeconds * 1000),
          });
      },

      async prune() {
        const client = await db();
        const { Timestamp } = await import("@google-cloud/firestore");
        const snap = await client
          .collection(CACHE_COLLECTION)
          .where("expiresAt", "<", Timestamp.now())
          .get();
        let deleted = 0;
        for (let i = 0; i < snap.docs.length; i += 450) {
          const batch = client.batch();
          for (const d of snap.docs.slice(i, i + 450)) {
            batch.delete(d.ref);
            deleted++;
          }
          await batch.commit();
        }
        return deleted;
      },
    },

    docs: {
      async readDoc(namespace, id) {
        const snap = await (await db())
          .collection(DOCS_COLLECTION)
          .doc(docKey(namespace, id))
          .get();
        if (!snap.exists) return null;
        return (snap.data() as { body?: string }).body ?? null;
      },

      async writeDoc(namespace, id, body) {
        await (await db())
          .collection(DOCS_COLLECTION)
          .doc(docKey(namespace, id))
          .set({ namespace, id, body, updatedAt: new Date().toISOString() });
      },

      async deleteDoc(namespace, id) {
        await (await db())
          .collection(DOCS_COLLECTION)
          .doc(docKey(namespace, id))
          .delete();
      },

      async listDocs(namespace) {
        const snap = await (await db())
          .collection(DOCS_COLLECTION)
          .where("namespace", "==", namespace)
          .get();
        return snap.docs.map((d) => (d.data() as { id: string }).id);
      },
    },
  };
}
