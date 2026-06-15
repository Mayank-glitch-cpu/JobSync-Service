// Server-side Search agent. Runs an autonomous Claude tool-use loop on behalf of
// one user (scope = uid via run-context), using the jobsync tools + Anthropic
// web_search to discover, vet, dedupe, and land jobs in the user's pipeline.

import type Anthropic from "@anthropic-ai/sdk";
import { runWithScope } from "../run-context.js";
import { getAnthropic } from "./anthropic.js";
import { searchAgentConfig } from "./ai-config.js";
import { buildToolBridge, runBridgedTool, SEARCH_AGENT_TOOLS } from "./tools-bridge.js";
import {
  auditFlagNotes,
  auditSearchRun,
  summarizeAudit,
  type AuditedJob,
  type AuditReport,
} from "./search-audit.js";
import { annotatePipelineEntries } from "../pipeline.js";

export interface SearchParams {
  lookbackHours?: number;
  /** Role keywords to target; overrides/augments the user's profile roles. */
  roles?: string[];
  /** Known company ATS slugs to pull directly (greenhouse/lever/ashby). */
  companies?: string[];
}

export interface SearchResult {
  added: number;
  updated: number;
  iterations: number;
  summary: string;
  /** Post-run audit of the jobs this run landed (recency/liveness/title/no-fabrication). */
  audit?: AuditReport;
}

// Loop budgets, model, and the knobs interpolated below all come from
// ai.config.json — see ai-config.ts (searchAgentConfig).

function buildSystemPrompt(maxJobsPerRun: number, webSearch: boolean): string {
  const webSearchLine = webSearch
    ? "\n   - Use web_search for broader discovery (e.g. site:job-boards.greenhouse.io <role>, site:jobs.lever.co <role>) when you need more candidates."
    : "";
  return `You are JobSync's autonomous job-search agent, running server-side for ONE user.
Your goal: find RECENT, RELEVANT job postings matching the user's profile, vet them, dedupe against what they've already seen, and add the new ones to THEIR pipeline.

Workflow:
1. Call profile_read to load the user's skills, experience, and activeRoles. If activeRoles is empty, infer target roles from their skills/experience and any roles passed in the kickoff.
2. Optionally call portals_read for the user's configured company boards.
3. Discover postings:
   - For known company ATS slugs, use fetch_greenhouse_jobs / fetch_lever_jobs / fetch_ashby_jobs / fetch_workday_jobs.${webSearchLine}
4. Enrich + filter each candidate: scrape_job_details (jobDescription, datePosted, salary), then filter_us_location and filter_title_keywords to drop irrelevant roles, classify_job_batch / detect_industry_tags to tag and score fit. Keep only jobs posted within the lookback window.
5. Verify links with verify_job_link_batch and drop dead ones.
6. Dedupe: cache_is_seen on the apply links; for misses also elasticsearch_list_recent_jobs to reconcile. Skip anything already seen.
7. Add the new, vetted jobs with pipeline_upsert_jobs — they land in this user's pipeline. Then cache_mark_seen for those jobs.
8. Finish with a concise one-paragraph summary: how many jobs you added and the notable companies/roles.

Rules:
- Only include jobs you VERIFIED are live and posted within the lookback window. Never fabricate postings or apply links.
- Be efficient: batch tool calls, and cap the run at ~${maxJobsPerRun} high-quality jobs.
- When done, stop and give your summary — do not loop indefinitely.`;
}

interface ProgressSink {
  (message: string): void;
}

type ContentBlock = Anthropic.Messages.ContentBlock;
type MessageParam = Anthropic.Messages.MessageParam;

/** Accumulate added/updated counts from pipeline_upsert_jobs tool outputs. */
function tallyUpsert(text: string, tally: { added: number; updated: number }): void {
  try {
    const parsed = JSON.parse(text) as { added?: number; updated?: number };
    if (typeof parsed.added === "number") tally.added += parsed.added;
    if (typeof parsed.updated === "number") tally.updated += parsed.updated;
  } catch {
    /* non-JSON output — ignore */
  }
}

/** Pull the jobs the agent passed to a pipeline_upsert_jobs call into AuditedJob shape. */
function collectUpsertedJobs(input: Record<string, unknown>, sink: AuditedJob[]): void {
  const jobs = input.jobs;
  if (!Array.isArray(jobs)) return;
  for (const j of jobs) {
    if (!j || typeof j !== "object") continue;
    const job = j as Record<string, unknown>;
    const applyLink = typeof job.applyLink === "string" ? job.applyLink : "";
    const positionTitle = typeof job.positionTitle === "string" ? job.positionTitle : "";
    if (!applyLink) continue;
    sink.push({
      applyLink,
      positionTitle,
      datePosted: typeof job.datePosted === "string" ? job.datePosted : undefined,
      company: typeof job.company === "string" ? job.company : undefined,
    });
  }
}

export async function runSearchAgent(
  uid: string,
  params: SearchParams,
  onProgress: ProgressSink = () => {},
): Promise<SearchResult> {
  return runWithScope(uid, async () => {
    const client = await getAnthropic();
    const cfg = searchAgentConfig();
    const systemPrompt = buildSystemPrompt(cfg.maxJobsPerRun, cfg.webSearch);
    const bridge = buildToolBridge(SEARCH_AGENT_TOOLS);
    const tally = { added: 0, updated: 0 };
    // Jobs the agent tried to land + every tool-result the agent observed — fed to
    // the post-run audit (recency/liveness/title/no-fabrication).
    const upsertedJobs: AuditedJob[] = [];
    let observedText = "";

    const lookbackHours = params.lookbackHours ?? 48;
    const kickoff =
      `Run a job search for me now. lookbackHours=${lookbackHours}.` +
      (params.roles?.length ? ` Target roles: ${params.roles.join(", ")}.` : "") +
      (params.companies?.length ? ` Known company slugs to pull: ${params.companies.join(", ")}.` : "") +
      ` Add the new, vetted jobs to my pipeline and summarize what you found.`;

    const tools: Anthropic.Messages.ToolUnion[] = [
      ...(bridge.tools as Anthropic.Messages.Tool[]),
      // Anthropic server tool — discovery via web search (run on Anthropic's side).
      ...(cfg.webSearch
        ? [{ type: "web_search_20260209", name: "web_search" } as Anthropic.Messages.ToolUnion]
        : []),
    ];

    const messages: MessageParam[] = [{ role: "user", content: kickoff }];
    let finalText = "";
    let iterations = 0;
    // web_search_20260209 runs dynamic filtering in a code-execution container.
    // Once that container exists, every subsequent request in the loop must
    // reattach to it via `container`, or the API 400s with
    // "container_id is required when there are pending tool uses generated by
    // code execution with tools." Thread the id through the loop.
    let containerId: string | undefined;

    while (iterations < cfg.maxIterations) {
      iterations++;
      const resp = await client.messages.create({
        model: cfg.model,
        max_tokens: cfg.maxTokens,
        ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
        system: systemPrompt,
        tools,
        messages,
        // Reattach to the web_search dynamic-filtering code-execution container
        // once it exists, or the API 400s on the next turn.
        container: containerId ?? null,
      });

      containerId = resp.container?.id ?? containerId;
      messages.push({ role: "assistant", content: resp.content });

      // Surface any text the model emitted this turn as progress.
      const turnText = (resp.content as ContentBlock[])
        .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join(" ")
        .trim();
      if (turnText) {
        finalText = turnText;
        onProgress(turnText.slice(0, 300));
      }

      if (resp.stop_reason === "end_turn") break;
      // Server tool (web_search) hit its internal loop limit — re-send to resume.
      if (resp.stop_reason === "pause_turn") continue;

      if (resp.stop_reason === "tool_use") {
        const toolUses = (resp.content as ContentBlock[]).filter(
          (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
        );
        const results: Anthropic.Messages.ToolResultBlockParam[] = [];
        for (const use of toolUses) {
          onProgress(`→ ${use.name}`);
          const input = use.input as Record<string, unknown>;
          const run = await runBridgedTool(bridge, use.name, input);
          if (use.name === "pipeline_upsert_jobs" && !run.isError) {
            tallyUpsert(run.text, tally);
            collectUpsertedJobs(input, upsertedJobs);
          }
          // Accumulate observed tool output for the no-fabrication audit check.
          observedText += run.text;
          results.push({
            type: "tool_result",
            tool_use_id: use.id,
            content: run.text.slice(0, cfg.toolResultMaxChars),
            is_error: run.isError,
          });
        }
        messages.push({ role: "user", content: results });
        continue;
      }

      // refusal / max_tokens / unknown — stop.
      break;
    }

    // Post-run audit: re-check what the agent actually landed. This is the same
    // verifier logic the eval suite uses — don't trust the model's summary/tally.
    let audit: AuditReport | undefined;
    if (upsertedJobs.length > 0) {
      try {
        audit = await auditSearchRun(upsertedJobs, observedText, {
          lookbackHours,
          roles: params.roles,
        });
        onProgress(summarizeAudit(audit));
        // Flag the offending pipeline entries (notes only — never touches status).
        const flags = auditFlagNotes(audit);
        if (flags.length > 0) {
          await annotatePipelineEntries(flags).catch((err) =>
            onProgress(`Could not flag audited jobs: ${err instanceof Error ? err.message : String(err)}`),
          );
        }
      } catch (err) {
        onProgress(`Audit could not run: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { added: tally.added, updated: tally.updated, iterations, summary: finalText, audit };
  });
}
