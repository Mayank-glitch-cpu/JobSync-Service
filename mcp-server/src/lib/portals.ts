import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../config.js";

export function getPortalsPath(): string {
  return join(CONFIG_DIR, "portals.yml");
}

function ensureDir(): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
}

export function readPortals(): { exists: boolean; raw: string; path: string } {
  const path = getPortalsPath();
  if (!existsSync(path)) return { exists: false, raw: "", path };
  return { exists: true, raw: readFileSync(path, "utf-8"), path };
}

export function writePortals(content: string): { path: string } {
  ensureDir();
  const path = getPortalsPath();
  writeFileSync(path, content, "utf-8");
  return { path };
}

// Embedded master company list — used by the onboard prompt as a reference.
// Agents select and customize from this list based on the user's role targets.
export const MASTER_COMPANY_LIST = `
# ── AI Labs & LLM providers ──
- name: Anthropic
  careers_url: https://job-boards.greenhouse.io/anthropic
  api: https://boards-api.greenhouse.io/v1/boards/anthropic/jobs
- name: OpenAI
  careers_url: https://openai.com/careers
  scan_method: websearch
  scan_query: 'site:openai.com/careers'
- name: Cohere
  careers_url: https://jobs.ashbyhq.com/cohere
- name: Mistral AI
  careers_url: https://jobs.lever.co/mistral
- name: Perplexity
  careers_url: https://jobs.ashbyhq.com/perplexity
- name: Hugging Face
  careers_url: https://apply.workable.com/huggingface/

# ── AI Infrastructure & LLMOps ──
- name: Arize AI
  careers_url: https://job-boards.greenhouse.io/arizeai
  api: https://boards-api.greenhouse.io/v1/boards/arizeai/jobs
- name: Langfuse
  careers_url: https://langfuse.com/careers
  scan_method: websearch
  scan_query: '"langfuse" careers jobs'
- name: Pinecone
  careers_url: https://jobs.ashbyhq.com/pinecone
- name: Weights & Biases
  careers_url: https://jobs.lever.co/wandb
- name: LangChain
  careers_url: https://jobs.ashbyhq.com/langchain
- name: RunPod
  careers_url: https://job-boards.greenhouse.io/runpod
  api: https://boards-api.greenhouse.io/v1/boards/runpod/jobs

# ── AI-native platforms ──
- name: Glean
  careers_url: https://job-boards.greenhouse.io/gleanwork
  api: https://boards-api.greenhouse.io/v1/boards/gleanwork/jobs
- name: Runway
  careers_url: https://job-boards.greenhouse.io/runwayml
  api: https://boards-api.greenhouse.io/v1/boards/runwayml/jobs
- name: Sierra
  careers_url: https://jobs.ashbyhq.com/sierra
- name: Decagon
  careers_url: https://jobs.ashbyhq.com/decagon
- name: Lindy
  careers_url: https://jobs.ashbyhq.com/lindy
- name: Clay Labs
  careers_url: https://jobs.ashbyhq.com/claylabs
- name: Hightouch
  careers_url: https://job-boards.greenhouse.io/hightouch
  api: https://boards-api.greenhouse.io/v1/boards/hightouch/jobs

# ── Voice AI & Conversational AI ──
- name: ElevenLabs
  careers_url: https://jobs.ashbyhq.com/elevenlabs
- name: Deepgram
  careers_url: https://jobs.ashbyhq.com/deepgram
- name: Vapi
  careers_url: https://jobs.ashbyhq.com/vapi
- name: Bland AI
  careers_url: https://jobs.ashbyhq.com/bland
- name: Hume AI
  careers_url: https://job-boards.greenhouse.io/humeai
  api: https://boards-api.greenhouse.io/v1/boards/humeai/jobs
- name: PolyAI
  careers_url: https://job-boards.eu.greenhouse.io/polyai
  api: https://boards-api.greenhouse.io/v1/boards/polyai/jobs
- name: Parloa
  careers_url: https://job-boards.eu.greenhouse.io/parloa
  api: https://boards-api.greenhouse.io/v1/boards/parloa/jobs

# ── Developer Tools & Infra ──
- name: Vercel
  careers_url: https://job-boards.greenhouse.io/vercel
  api: https://boards-api.greenhouse.io/v1/boards/vercel/jobs
- name: Supabase
  careers_url: https://jobs.ashbyhq.com/supabase
- name: Temporal
  careers_url: https://job-boards.greenhouse.io/temporal
  api: https://boards-api.greenhouse.io/v1/boards/temporal/jobs
- name: WorkOS
  careers_url: https://jobs.ashbyhq.com/workos
- name: PlanetScale
  careers_url: https://job-boards.greenhouse.io/planetscale
  api: https://boards-api.greenhouse.io/v1/boards/planetscale/jobs
- name: Inngest
  careers_url: https://jobs.ashbyhq.com/inngest
- name: Resend
  careers_url: https://jobs.ashbyhq.com/resend
- name: Clerk
  careers_url: https://jobs.ashbyhq.com/clerk

# ── No-Code / Automation ──
- name: Retool
  careers_url: https://retool.com/careers
  scan_method: websearch
  scan_query: 'site:retool.com/careers'
- name: Airtable
  careers_url: https://job-boards.greenhouse.io/airtable
  api: https://boards-api.greenhouse.io/v1/boards/airtable/jobs
- name: n8n
  careers_url: https://jobs.ashbyhq.com/n8n
- name: Zapier
  careers_url: https://jobs.ashbyhq.com/zapier

# ── SaaS & Enterprise ──
- name: Salesforce
  careers_url: https://careers.salesforce.com
  scan_method: websearch
  scan_query: 'site:careers.salesforce.com "Software Engineer" OR "AI Engineer"'
- name: Intercom
  careers_url: https://job-boards.greenhouse.io/intercom
  api: https://boards-api.greenhouse.io/v1/boards/intercom/jobs
- name: Gong
  careers_url: https://www.gong.io/careers
  scan_method: websearch
  scan_query: 'site:gong.io/careers'
- name: Twilio
  careers_url: https://www.twilio.com/en-us/company/jobs
  scan_method: websearch
  scan_query: 'site:twilio.com/company/jobs'

# ── Finance / Quant ──
- name: Stripe
  careers_url: https://stripe.com/jobs
  scan_method: websearch
  scan_query: 'site:stripe.com/jobs'
- name: Plaid
  careers_url: https://job-boards.greenhouse.io/plaid
  api: https://boards-api.greenhouse.io/v1/boards/plaid/jobs
- name: Brex
  careers_url: https://jobs.ashbyhq.com/brex
- name: Ramp
  careers_url: https://jobs.ashbyhq.com/ramp
`.trim();
