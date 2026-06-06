// Server-side Search agent. Runs an autonomous Claude tool-use loop on behalf of
// one user (scope = uid via run-context), using the jobsync tools + Anthropic
// web_search to discover, vet, dedupe, and land jobs in the user's pipeline.

import type Anthropic from "@anthropic-ai/sdk";
import { runWithScope } from "../run-context.js";
import { agentModel, getAnthropic } from "./anthropic.js";
import { buildToolBridge, runBridgedTool, SEARCH_AGENT_TOOLS } from "./tools-bridge.js";

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
}

const MAX_ITERATIONS = 40;
const MAX_TOKENS = 16000;

const SYSTEM_PROMPT = `You are JobSync's autonomous job-search agent, running server-side for ONE user.
Your goal: find RECENT, RELEVANT job postings matching the user's profile, vet them, dedupe against what they've already seen, and add the new ones to THEIR pipeline.

Workflow:
1. Call profile_read to load the user's skills, experience, and activeRoles. If activeRoles is empty, infer target roles from their skills/experience and any roles passed in the kickoff.
2. Optionally call portals_read for the user's configured company boards.
3. Discover postings:
   - For known company ATS slugs, use fetch_greenhouse_jobs / fetch_lever_jobs / fetch_ashby_jobs / fetch_workday_jobs.
   - Use web_search for broader discovery (e.g. site:job-boards.greenhouse.io <role>, site:jobs.lever.co <role>) when you need more candidates.
4. Enrich + filter each candidate: scrape_job_details (jobDescription, datePosted, salary), then filter_us_location and filter_title_keywords to drop irrelevant roles, classify_job_batch / detect_industry_tags to tag and score fit. Keep only jobs posted within the lookback window.
5. Verify links with verify_job_link_batch and drop dead ones.
6. Dedupe: cache_is_seen on the apply links; for misses also elasticsearch_list_recent_jobs to reconcile. Skip anything already seen.
7. Add the new, vetted jobs with pipeline_upsert_jobs — they land in this user's pipeline. Then cache_mark_seen for those jobs.
8. Finish with a concise one-paragraph summary: how many jobs you added and the notable companies/roles.

Rules:
- Only include jobs you VERIFIED are live and posted within the lookback window. Never fabricate postings or apply links.
- Be efficient: batch tool calls, and cap the run at ~25 high-quality jobs.
- When done, stop and give your summary — do not loop indefinitely.`;

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

export async function runSearchAgent(
  uid: string,
  params: SearchParams,
  onProgress: ProgressSink = () => {},
): Promise<SearchResult> {
  return runWithScope(uid, async () => {
    const client = await getAnthropic();
    const bridge = buildToolBridge(SEARCH_AGENT_TOOLS);
    const tally = { added: 0, updated: 0 };

    const lookbackHours = params.lookbackHours ?? 48;
    const kickoff =
      `Run a job search for me now. lookbackHours=${lookbackHours}.` +
      (params.roles?.length ? ` Target roles: ${params.roles.join(", ")}.` : "") +
      (params.companies?.length ? ` Known company slugs to pull: ${params.companies.join(", ")}.` : "") +
      ` Add the new, vetted jobs to my pipeline and summarize what you found.`;

    const tools = [
      ...bridge.tools,
      // Anthropic server tool — discovery via web search (run on Anthropic's side).
      { type: "web_search_20260209", name: "web_search" },
    ] as unknown as Anthropic.Messages.ToolUnion[];

    const messages: MessageParam[] = [{ role: "user", content: kickoff }];
    let finalText = "";
    let iterations = 0;

    while (iterations < MAX_ITERATIONS) {
      iterations++;
      const resp = await client.messages.create({
        model: agentModel(),
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        tools,
        messages,
      });

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
          const run = await runBridgedTool(bridge, use.name, use.input as Record<string, unknown>);
          if (use.name === "pipeline_upsert_jobs" && !run.isError) tallyUpsert(run.text, tally);
          results.push({
            type: "tool_result",
            tool_use_id: use.id,
            content: run.text.slice(0, 60000),
            is_error: run.isError,
          });
        }
        messages.push({ role: "user", content: results });
        continue;
      }

      // refusal / max_tokens / unknown — stop.
      break;
    }

    return { added: tally.added, updated: tally.updated, iterations, summary: finalText };
  });
}
