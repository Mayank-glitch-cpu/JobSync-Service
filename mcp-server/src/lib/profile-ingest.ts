// Shared resume → profile ingestion, used by both the Firebase-authed dashboard
// route (POST /api/profile/resume) and the machine-to-machine external API
// (POST /api/external/profile). Everything is scoped to a uid exactly the way
// the dashboard scopes to the Firebase uid.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeRoles,
  readProfileFile,
  readRawResume,
  readRoles,
  writeProfileFile,
  writeRawResume,
  writeResumeBlob,
  writeRoles,
} from "./profile.js";
import { readPersonalProfile } from "./personal-profile.js";
import { parseResume } from "./resume-parser.js";
import { structureResume, type StructuredProfile } from "./profile-extract.js";

/** The profile as the dashboard and the external API both report it. */
export async function profileSnapshot(uid: string) {
  const [roles, skills, experience, projects, personal, rawResume] = await Promise.all([
    readRoles(uid),
    readProfileFile("skills", uid),
    readProfileFile("experience", uid),
    readProfileFile("projects", uid),
    readPersonalProfile(uid),
    readRawResume(uid),
  ]);
  return {
    roles,
    activeRoles: activeRoles(roles),
    skills,
    experience,
    projects,
    personal,
    hasResume: rawResume.length > 0,
  };
}

/**
 * Store a resume for `uid` and derive the search profile from it: raw text (for
 * agent context), the original bytes (so Auto-Apply can attach the real file to
 * an upload field), and the LLM-structured roles/skills/experience/projects.
 *
 * Requires an LLM to be configured — callers should check `isLlmConfigured()`
 * first so they can return a 503 instead of throwing.
 */
export async function ingestResume(
  uid: string,
  file: { base64: string; filename?: string },
): Promise<{ chars: number; structured: StructuredProfile }> {
  const filename = file.filename?.trim() || "resume.pdf";
  const dir = join(tmpdir(), `jobsync-resume-${randomUUID()}`);
  const path = join(dir, filename.replace(/[^\w.\-]/g, "_"));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, Buffer.from(file.base64, "base64"));
    const text = await parseResume(path);
    await writeRawResume(text, uid);
    await writeResumeBlob(file.base64, filename, uid);
    const structured = await structureResume(text);
    await Promise.all([
      writeRoles({ detected: structured.roles, custom: [], excluded: [] }, uid),
      writeProfileFile("skills", structured.skills.map((s) => `- ${s}`).join("\n"), uid),
      writeProfileFile("experience", structured.experience, uid),
      writeProfileFile("projects", structured.projects, uid),
    ]);
    return { chars: text.length, structured };
  } finally {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}
