import { textResult, type ModelTier, type ToolDefinition } from "./index.js";

type WorkflowContext = "scrape" | "onboarding" | "classification" | "extraction" | "freeform";

interface ModelRecommendation {
  recommended: ModelTier;
  genericTier: "fast" | "balanced" | "deep";
  anthropicModel: string;
  reason: string;
  estimatedTokensSaved?: string;
  fallback?: string;
}

const TIER_META: Record<ModelTier, { generic: "fast" | "balanced" | "deep"; model: string }> = {
  haiku: { generic: "fast", model: "claude-haiku-4-5" },
  sonnet: { generic: "balanced", model: "claude-sonnet-4-6" },
  opus: { generic: "deep", model: "claude-opus-4-7" },
};

// Tool-name → tier mapping (mirrors the table in the issue)
const TOOL_TIER: Record<string, ModelTier> = {
  jobsync_ping: "haiku",
  cache_is_seen: "haiku",
  cache_mark_seen: "haiku",
  cache_prune: "haiku",
  filter_us_location: "haiku",
  filter_title_keywords: "haiku",
  airtable_list_recent_jobs: "haiku",
  airtable_get_schema: "haiku",
  airtable_list_bases: "haiku",
  airtable_create_base: "haiku",
  markdown_append_jobs: "haiku",
  verify_job_link: "haiku",
  verify_job_link_batch: "haiku",
  ashby_get_date_posted: "haiku",
  ashby_get_date_posted_batch: "haiku",
  fetch_greenhouse_jobs: "haiku",
  fetch_lever_jobs: "haiku",
  fetch_ashby_jobs: "haiku",
  fetch_workday_jobs: "haiku",
  classify_job_batch: "sonnet",
  detect_industry_tags: "sonnet",
  profile_parse_resume: "sonnet",
  airtable_upsert_job: "sonnet",
  profile_update_roles: "opus",
  suggest_model_for_query: "haiku",
};

const CONTEXT_TIER: Record<WorkflowContext, ModelTier> = {
  scrape: "haiku",
  classification: "sonnet",
  extraction: "sonnet",
  onboarding: "opus",
  freeform: "sonnet",
};

const CONTEXT_REASON: Record<WorkflowContext, string> = {
  scrape:
    "Scrape workflow steps are mostly deterministic tool chains (filter, dedup, cache, upsert). Haiku handles these with identical quality at a fraction of the cost.",
  classification:
    "Classification and tag detection involve light semantic matching — Sonnet gives the right balance of accuracy and speed.",
  extraction:
    "Job-field extraction requires structured reasoning over free-form JD text. Sonnet handles ambiguous postings reliably.",
  onboarding:
    "Profile onboarding involves nuanced role inference from resume text. Sonnet or Opus gives the best role-fit accuracy.",
  freeform:
    "For open-ended or ambiguous queries, Sonnet is the safe default unless multi-doc reasoning is needed (use Opus then).",
};

function classifyQuery(query: string): ModelTier {
  const q = query.toLowerCase();

  // Deterministic / structural signals → haiku
  if (
    /\b(ping|cache|dedup|filter|verify|link|upsert|append|markdown|list|schema|base|fetch|scrape step)\b/.test(q)
  )
    return "haiku";

  // Deep reasoning signals → opus
  if (
    /\b(resume|profile|role fit|ambiguous|multi.?doc|synthesis|nuanced|infer|career|seniority match)\b/.test(q)
  )
    return "opus";

  // Everything else → sonnet
  return "sonnet";
}

function estimateSavings(tier: ModelTier): string | undefined {
  if (tier === "haiku")
    return "~10–25× cheaper per token vs Opus; ~3–5× cheaper vs Sonnet for the same call";
  if (tier === "sonnet")
    return "~3–5× cheaper per token vs Opus";
  return undefined;
}

function recommend(query: string, context?: WorkflowContext, toolName?: string): ModelRecommendation {
  let tier: ModelTier;
  let reason: string;

  if (toolName && TOOL_TIER[toolName]) {
    tier = TOOL_TIER[toolName];
    reason = `Static mapping: \`${toolName}\` is a ${tier === "haiku" ? "deterministic structured" : tier === "sonnet" ? "semantic/enrichment" : "deep-reasoning"} tool — ${TIER_META[tier].generic} tier is optimal.`;
  } else if (context) {
    tier = CONTEXT_TIER[context];
    reason = CONTEXT_REASON[context];
  } else {
    tier = classifyQuery(query);
    reason =
      tier === "haiku"
        ? "Query pattern matches deterministic/structural tooling — no LLM reasoning needed."
        : tier === "opus"
        ? "Query involves nuanced reasoning, resume/role inference, or multi-doc synthesis where Opus quality matters."
        : "General semantic task — Sonnet gives the right cost-vs-quality balance.";
  }

  const meta = TIER_META[tier];
  return {
    recommended: tier,
    genericTier: meta.generic,
    anthropicModel: meta.model,
    reason,
    estimatedTokensSaved: estimateSavings(tier),
    ...(tier !== "haiku" && {
      fallback: tier === "opus" ? "sonnet — acceptable for most extraction tasks" : undefined,
    }),
  };
}

export const suggestModelForQueryTool: ToolDefinition = {
  name: "suggest_model_for_query",
  description:
    "Advisory tool. Given a query or workflow step description, returns the recommended Claude model tier " +
    "(haiku / sonnet / opus) with a reason and estimated token savings. " +
    "Use this to pick the cheapest model that will produce correct output for the next step. " +
    "⚡ [Model hint: haiku]",
  recommendedModel: "haiku",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The task or question you are about to run (free-form description).",
      },
      context: {
        type: "string",
        enum: ["scrape", "onboarding", "classification", "extraction", "freeform"],
        description: "Optional workflow context to narrow the recommendation.",
      },
      toolName: {
        type: "string",
        description: "Optional: the exact JobSync tool name you are about to call. Returns the static per-tool mapping.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const query = String(args.query ?? "");
    const context = args.context as WorkflowContext | undefined;
    const toolName = args.toolName ? String(args.toolName) : undefined;
    return textResult(recommend(query, context, toolName));
  },
};
