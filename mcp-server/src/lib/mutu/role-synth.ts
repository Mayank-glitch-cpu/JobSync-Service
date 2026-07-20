// Role synthesis: aggregate the Mutu user base (demographics + parsed resumes)
// and ask the existing LLM runtime (lib/agent/llm.ts — Anthropic by default)
// which roles the jobs table should be seeded with. The output feeds the
// agentic search (/api/external/search) and breadth pulls.

import { isLlmConfigured, llmJson } from "../agent/llm.js";
import { aiCall } from "../agent/ai-config.js";
import {
  latestRoleSynthRun,
  listResumes,
  listUsers,
  saveRoleSynthRun,
  type RoleSynthRun,
  type SynthesizedRole,
} from "./db.js";

const SYSTEM = `You are a labor-market analyst for a job recommendation platform.
Given an anonymized snapshot of the platform's user base (demographics + parsed resumes),
identify the job roles the platform should aggregate postings for. Prefer concrete,
searchable role titles (e.g. "Machine Learning Engineer", not "tech roles"). Weight
roles by how many users they serve and note visa/work-authorization constraints
where they matter.`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    roles: {
      type: "array",
      items: {
        type: "object",
        properties: {
          role: { type: "string", description: "Searchable job title" },
          rationale: { type: "string", description: "Why this role serves the user base" },
          demand_signals: {
            type: "array",
            items: { type: "string" },
            description: "Skills/degrees/experience in the user base supporting this role",
          },
        },
        required: ["role", "rationale", "demand_signals"],
        additionalProperties: false,
      },
    },
  },
  required: ["roles"],
  additionalProperties: false,
} as const;

/** Anonymized, token-bounded snapshot of the user base for the prompt. */
export async function buildUserBaseSnapshot(): Promise<{
  snapshot: string;
  userCount: number;
  resumeCount: number;
}> {
  const [users, resumes] = await Promise.all([listUsers(), listResumes()]);
  const byUser = new Map(resumes.map((r) => [r.userId, r]));

  const lines = users.slice(0, 200).map((u, i) => {
    const r = byUser.get(u.userId);
    const p = r?.parsed;
    const parts = [
      `user ${i + 1}`,
      u.country ? `country=${u.country}` : null,
      u.workAuthorization ? `work_auth=${u.workAuthorization}` : null,
      p?.desired_position ? `wants=${p.desired_position}` : null,
      p?.skills?.length
        ? `skills=${p.skills.slice(0, 12).map((s) => s.skill_name).join("|")}`
        : null,
      p?.educations?.length
        ? `education=${p.educations
            .slice(0, 2)
            .map((e) => `${e.degree ?? "?"} ${e.programme ?? ""}`.trim())
            .join("|")}`
        : null,
      p?.experiences?.length ? `experience_entries=${p.experiences.length}` : null,
    ].filter(Boolean);
    return parts.join(" · ");
  });

  return {
    snapshot: lines.join("\n") || "(no users yet)",
    userCount: users.length,
    resumeCount: resumes.length,
  };
}

export interface SynthesizeOptions {
  /** Extra steering from the caller (e.g. "focus on US new-grad roles"). */
  guidance?: string;
}

export async function synthesizeRoles(opts: SynthesizeOptions = {}): Promise<RoleSynthRun> {
  if (!isLlmConfigured()) {
    throw new Error("Role synthesis needs an LLM backend (set ANTHROPIC_API_KEY or the JOBSYNC_LLM_* envs).");
  }
  const { snapshot, userCount, resumeCount } = await buildUserBaseSnapshot();
  if (userCount === 0) {
    throw new Error("No Mutu users ingested yet — POST /api/mutu/users first.");
  }

  const prompt = [
    `User base snapshot (${userCount} users, ${resumeCount} parsed resumes):`,
    snapshot,
    opts.guidance ? `\nAdditional guidance: ${opts.guidance}` : "",
    "\nReturn 5-15 roles that best cover this user base.",
  ].join("\n");

  const raw = await llmJson("roleSynthesis", {
    system: SYSTEM,
    prompt,
    schema: RESPONSE_SCHEMA as unknown as Record<string, unknown>,
    schemaName: "role_synthesis",
  });

  let roles: SynthesizedRole[];
  try {
    const parsed = JSON.parse(raw) as { roles?: SynthesizedRole[] };
    roles = (parsed.roles ?? []).filter((r) => r.role?.trim());
  } catch {
    throw new Error("Role-synthesis model returned unparseable JSON.");
  }
  if (roles.length === 0) throw new Error("Role synthesis produced no roles.");

  return saveRoleSynthRun({
    userCount,
    resumeCount,
    roles,
    model: aiCall("roleSynthesis").model,
  });
}

export { latestRoleSynthRun };
