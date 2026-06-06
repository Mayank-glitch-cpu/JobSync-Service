// Structure a raw resume into roles/skills/experience/projects via one Claude
// call. This replaces the interactive MCP onboarding prompt for the self-serve
// dashboard flow (where there's no MCP client to drive structuring).

import type Anthropic from "@anthropic-ai/sdk";
import { agentModel, getAnthropic } from "./agent/anthropic.js";

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
  const client = await getAnthropic();
  const resp = await client.messages.create({
    model: agentModel(),
    max_tokens: 4000,
    system: SYSTEM,
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
    messages: [
      {
        role: "user",
        content: `Structure this resume into the required JSON profile:\n\n${rawText.slice(0, 40000)}`,
      },
    ],
  } as Anthropic.Messages.MessageCreateParamsNonStreaming);

  const text = (resp.content as Anthropic.Messages.ContentBlock[])
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  const parsed = JSON.parse(text) as StructuredProfile;
  return {
    roles: parsed.roles ?? [],
    skills: parsed.skills ?? [],
    experience: parsed.experience ?? "",
    projects: parsed.projects ?? "",
  };
}
