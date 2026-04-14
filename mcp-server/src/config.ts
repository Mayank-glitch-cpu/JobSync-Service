import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type JobSink = "airtable" | "markdown" | "both";

export interface JobSyncConfig {
  airtable: {
    pat: string;
    baseId: string;
    tableName: string;
    fieldMap?: Record<string, string>;
  };
  sink: JobSink;
  markdownPath: string;
  lookbackHours: number;
  usOnly: boolean;
  enableFastPath: boolean;
  profileDir: string;
}

const DEFAULTS: Omit<JobSyncConfig, "airtable"> = {
  sink: "airtable",
  markdownPath: join(homedir(), ".jobsync", "jobs.md"),
  lookbackHours: 12,
  usOnly: true,
  enableFastPath: false,
  profileDir: join(homedir(), ".jobsync", "profile"),
};

export const CONFIG_DIR = join(homedir(), ".jobsync");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");
export const CACHE_DB_PATH = join(CONFIG_DIR, "cache.db");

export function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
}

export function loadConfig(): JobSyncConfig {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      `Config not found at ${CONFIG_PATH}. Run \`jobsync-mcp init\` to create one.`,
    );
  }
  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  const merged: JobSyncConfig = {
    ...DEFAULTS,
    ...raw,
    airtable: {
      pat: "",
      baseId: "",
      tableName: "Jobs",
      ...raw.airtable,
    },
  };
  const needsAirtable = merged.sink === "airtable" || merged.sink === "both";
  if (needsAirtable && (!merged.airtable.pat || !merged.airtable.baseId)) {
    throw new Error(
      `Config at ${CONFIG_PATH} has sink=${merged.sink} but is missing airtable.pat or airtable.baseId.`,
    );
  }
  return merged;
}

export function saveConfig(cfg: JobSyncConfig): void {
  ensureConfigDir();
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

export function configExists(): boolean {
  return existsSync(CONFIG_PATH);
}
