// Structure a raw resume into roles/skills/experience/projects via one Claude
// call. This replaces the interactive MCP onboarding prompt for the self-serve
// dashboard flow (where there's no MCP client to drive structuring).

import { llmJson } from "./agent/llm.js";

export interface StructuredProfile {
  roles: string[];
  skills: string[];
  experience: string;
  projects: string;
}

const SCHEMA = {
  type: "object",
  properties: {
    roles: {
      type: "array",
      items: { type: "string" },
      description: "3-8 target job titles this candidate should apply to, e.g. 'Backend Engineer'.",
    },
    skills: { type: "array", items: { type: "string" }, description: "Key technical + domain skills." },
    experience: { type: "string", description: "Concise markdown summary of work experience." },
    projects: { type: "string", description: "Concise markdown summary of notable projects (may be empty)." },
  },
  required: ["roles", "skills", "experience", "projects"],
  additionalProperties: false,
} as const;

const SYSTEM =
  "You structure a candidate's resume into a job-search profile. Infer realistic target job titles (roles) from their experience and skills. Be faithful to the resume — do not invent experience.";

export async function structureResume(rawText: string): Promise<StructuredProfile> {
  const text = await llmJson("structureResume", {
    system: SYSTEM,
    prompt: `Structure this resume into the required JSON profile:\n\n${rawText.slice(0, 40000)}`,
    schema: SCHEMA as unknown as Record<string, unknown>,
    schemaName: "resume_profile",
  });

  const parsed = JSON.parse(text) as StructuredProfile;
  return {
    roles: parsed.roles ?? [],
    skills: parsed.skills ?? [],
    experience: parsed.experience ?? "",
    projects: parsed.projects ?? "",
  };
}
