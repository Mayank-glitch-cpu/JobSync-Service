import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type JobSink = "airtable" | "markdown" | "both";

/** Inclusive `[min, max]` millisecond range; a value is drawn uniformly from it. */
export type MsRange = [number, number];

/**
 * Tunables for the human-like pacing of the browser auto-apply agent. Every
 * delay is randomised within its range so the cadence never repeats, and the
 * whole set is scaled by `speed` (0.5 ≈ twice as fast, 2 ≈ twice as slow/safe).
 * Set `enabled: false` to fill instantly (fastest, but trivially bot-detectable
 * — useful for local testing against your own forms).
 */
export interface ApplyHumanizeConfig {
  enabled: boolean;
  /** Multiplier applied to every delay below. 1 = defaults. */
  speed: number;
  /** Per-keystroke delay while typing text fields. */
  keystrokeMs: MsRange;
  /** Probability (0–1) of a longer "thinking" pause between keystrokes. */
  thinkProbability: number;
  /** Duration of that thinking pause when it fires. */
  thinkPauseMs: MsRange;
  /** Pause after each completed field. */
  betweenFieldsMs: MsRange;
  /** Probability (0–1) of an idle scroll between fields. */
  scrollProbability: number;
  /** Hesitation before clicking the final submit button. */
  preSubmitMs: MsRange;
}

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
  brandedOutput: boolean;
  applyHumanize: ApplyHumanizeConfig;
}

export const DEFAULT_APPLY_HUMANIZE: ApplyHumanizeConfig = {
  enabled: true,
  speed: 1,
  keystrokeMs: [45, 140],
  thinkProbability: 0.07,
  thinkPauseMs: [180, 460],
  betweenFieldsMs: [200, 700],
  scrollProbability: 0.3,
  preSubmitMs: [500, 1200],
};

const DEFAULTS: Omit<JobSyncConfig, "airtable"> = {
  sink: "airtable",
  markdownPath: join(homedir(), ".jobsync", "jobs.md"),
  lookbackHours: 12,
  usOnly: true,
  enableFastPath: false,
  profileDir: join(homedir(), ".jobsync", "profile"),
  brandedOutput: true,
  applyHumanize: DEFAULT_APPLY_HUMANIZE,
};

export const CONFIG_DIR = join(homedir(), ".jobsync");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");
export const CACHE_DB_PATH = join(CONFIG_DIR, "cache.db");

export function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
}

export function loadConfig(): JobSyncConfig {
  const envConfig = loadConfigFromEnv();
  if (envConfig) return envConfig;

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
    applyHumanize: {
      ...DEFAULT_APPLY_HUMANIZE,
      ...raw.applyHumanize,
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

function loadConfigFromEnv(): JobSyncConfig | null {
  const pat = process.env.AIRTABLE_PAT ?? process.env.AIRTABLE_API_KEY;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!pat || !baseId) return null;

  const sink = (process.env.JOBSYNC_SINK ?? "airtable") as JobSink;
  const lookbackHours = Number(process.env.JOBSYNC_LOOKBACK_HOURS ?? 12);
  return {
    ...DEFAULTS,
    sink,
    markdownPath: process.env.JOBSYNC_MARKDOWN_PATH ?? DEFAULTS.markdownPath,
    lookbackHours: Number.isFinite(lookbackHours) ? lookbackHours : DEFAULTS.lookbackHours,
    usOnly: process.env.JOBSYNC_US_ONLY === "false" ? false : DEFAULTS.usOnly,
    enableFastPath: process.env.JOBSYNC_ENABLE_FAST_PATH === "true",
    profileDir: process.env.JOBSYNC_PROFILE_DIR ?? DEFAULTS.profileDir,
    brandedOutput: process.env.JOBSYNC_BRANDED_OUTPUT === "false" ? false : DEFAULTS.brandedOutput,
    airtable: {
      pat,
      baseId,
      tableName: process.env.AIRTABLE_TABLE_NAME ?? "Jobs",
      fieldMap: {},
    },
    applyHumanize: DEFAULT_APPLY_HUMANIZE,
  };
}

export function saveConfig(cfg: JobSyncConfig): void {
  ensureConfigDir();
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

export function configExists(): boolean {
  return existsSync(CONFIG_PATH);
}

/**
 * Lightweight accessor for the brandedOutput flag. Reads the config file
 * directly on first call (no airtable validation so it works even on a
 * half-initialised config) and caches the result for the process lifetime.
 * Defaults to true when the config is missing or unreadable.
 */
let _brandedOutputCached: boolean | null = null;
export function isBrandedOutput(): boolean {
  if (_brandedOutputCached !== null) return _brandedOutputCached;
  try {
    if (!existsSync(CONFIG_PATH)) {
      _brandedOutputCached = true;
      return true;
    }
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    _brandedOutputCached = raw.brandedOutput !== false;
  } catch {
    _brandedOutputCached = true;
  }
  return _brandedOutputCached;
}
