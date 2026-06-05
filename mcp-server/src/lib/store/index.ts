// Resolves and memoizes the active StorageAdapter for the process, based on
// the storage backend in config/env (see config.ts:getStorageConfig).

import { getStorageConfig } from "../../config.js";
import { localAdapter } from "./local.js";
import type { StorageAdapter } from "./types.js";

export type { StorageAdapter, SeenJob } from "./types.js";

let adapterPromise: Promise<StorageAdapter> | null = null;

export function getStore(): Promise<StorageAdapter> {
  if (!adapterPromise) {
    adapterPromise = (async () => {
      const cfg = getStorageConfig();
      if (cfg.backend === "firestore") {
        const { createFirestoreAdapter } = await import("./firestore.js");
        const adapter = createFirestoreAdapter({
          projectId: cfg.projectId,
          databaseId: cfg.databaseId,
        });
        console.error(
          `jobsync-mcp storage backend: firestore (project=${cfg.projectId ?? "ADC-default"}, db=${cfg.databaseId ?? "(default)"})`,
        );
        return adapter;
      }
      console.error("jobsync-mcp storage backend: local (sqlite + ~/.jobsync)");
      return localAdapter;
    })();
  }
  return adapterPromise;
}
