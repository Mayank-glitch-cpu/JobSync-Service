// Client for the cloud resume-parser worker (infra/resume-parser-worker), which
// hosts sukhrobnurali/qwen3vl-resume-parser on GPU. The Node server never loads
// the model — it forwards the uploaded file and validates the returned JSON.
//
// Env:
//   RESUME_PARSER_URL    base URL of the worker (e.g. Cloud Run GPU service)
//   RESUME_PARSER_TOKEN  optional bearer for the worker
//   JOBSYNC_MUTU_PARSER  "remote" | "stub" — defaults to remote when a URL is
//                        set, stub otherwise (so the API contract is testable
//                        without GPU spend).

import { normalizeParsedResume, type ParsedResume } from "./schema.js";

export const PARSER_MODEL_ID = "sukhrobnurali/qwen3vl-resume-parser";

export interface ResumeUpload {
  filename: string;
  /** base64-encoded file body (PDF, PNG, or JPEG). */
  contentBase64: string;
}

export interface ParseResult {
  parsed: ParsedResume;
  parserModel: string;
}

type ParserMode = "remote" | "stub";

export function parserMode(): ParserMode {
  const explicit = (process.env.JOBSYNC_MUTU_PARSER ?? "").toLowerCase();
  if (explicit === "stub") return "stub";
  if (explicit === "remote") return "remote";
  return process.env.RESUME_PARSER_URL ? "remote" : "stub";
}

const ALLOWED_EXTENSIONS = new Set([".pdf", ".png", ".jpg", ".jpeg"]);
/** 15 MB decoded — multi-page resume PDFs are far below this. */
const MAX_BYTES = 15 * 1024 * 1024;

export function validateUpload(upload: ResumeUpload): void {
  const dot = upload.filename.lastIndexOf(".");
  const ext = dot >= 0 ? upload.filename.slice(dot).toLowerCase() : "";
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported resume format "${ext || upload.filename}". Use .pdf, .png, or .jpg.`);
  }
  const approxBytes = Math.floor((upload.contentBase64.length * 3) / 4);
  if (approxBytes > MAX_BYTES) {
    throw new Error(`Resume file too large (~${Math.round(approxBytes / 1024 / 1024)} MB; limit 15 MB).`);
  }
  if (approxBytes === 0) throw new Error("Empty resume upload.");
}

async function parseRemote(upload: ResumeUpload): Promise<ParseResult> {
  const base = process.env.RESUME_PARSER_URL;
  if (!base) {
    throw new Error("RESUME_PARSER_URL is not set — deploy infra/resume-parser-worker and point this env at it.");
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (process.env.RESUME_PARSER_TOKEN) {
    headers.authorization = `Bearer ${process.env.RESUME_PARSER_TOKEN}`;
  }
  const resp = await fetch(`${base.replace(/\/$/, "")}/parse`, {
    method: "POST",
    headers,
    body: JSON.stringify({ filename: upload.filename, content_base64: upload.contentBase64 }),
    signal: AbortSignal.timeout(180_000), // cold GPU starts are slow
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`Resume parser worker responded ${resp.status}: ${detail.slice(0, 300)}`);
  }
  const body = (await resp.json()) as { resume?: unknown; model?: string };
  return {
    parsed: normalizeParsedResume(body.resume ?? body),
    parserModel: body.model ?? PARSER_MODEL_ID,
  };
}

/** Deterministic stub keyed off the filename — full 23-field shape, no GPU. */
function parseStub(upload: ResumeUpload): ParseResult {
  const stem = upload.filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || "Unknown";
  const parsed = normalizeParsedResume({
    first_name: stem.split(/\s+/)[0] ?? null,
    last_name: stem.split(/\s+/).slice(1).join(" ") || null,
    date_of_birth: null,
    email: null,
    phone: null,
    desired_position: "Software Engineer",
    about: `[stub parse of ${upload.filename} — set RESUME_PARSER_URL for real inference]`,
    job_experience: null,
    job_expectations: null,
    min_salary: null,
    max_salary: null,
    ready_to_relocation: false,
    work_modes: [],
    employment_types: [],
    employment_durations: [],
    hobbies: null,
    address: null,
    skills: [{ skill_name: "Python", level: null }],
    experiences: [],
    languages: [],
    educations: [],
    certificates: [],
    projects: [],
  });
  return { parsed, parserModel: "stub" };
}

export async function parseResumeUpload(upload: ResumeUpload): Promise<ParseResult> {
  validateUpload(upload);
  return parserMode() === "remote" ? parseRemote(upload) : parseStub(upload);
}
