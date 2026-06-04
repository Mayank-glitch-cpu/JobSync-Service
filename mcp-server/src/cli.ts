import { createInterface } from "node:readline/promises";
import { CONFIG_PATH, DEFAULT_APPLY_HUMANIZE, configExists, loadConfig, saveConfig, type JobSink, type JobSyncConfig } from "./config.js";
import { createJobSyncBase, listBases } from "./lib/airtable-meta.js";
import { parseResume } from "./lib/resume-parser.js";
import { ensureProfileDir, rawResumePath, writeRawResume } from "./lib/profile.js";
import { BRAND_LOGO_BANNER } from "./lib/brand.js";

function printBanner() {
  console.log(BRAND_LOGO_BANNER);
}

async function runInit() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string, def?: string): Promise<string> => {
    const suffix = def ? ` [${def}]` : "";
    const ans = (await rl.question(`${q}${suffix}: `)).trim();
    return ans || def || "";
  };

  let existing: Partial<JobSyncConfig> = {};
  try {
    if (configExists()) existing = loadConfig();
  } catch {
    // fall through — treat as first-time init
  }

  console.log(`\njobsync-mcp init — writing to ${CONFIG_PATH}\n`);
  console.log(`Pick a sink for job records:`);
  console.log(`  1) airtable  — write to your Airtable base (recommended)`);
  console.log(`  2) markdown  — append to a local markdown file (no Airtable needed)`);
  console.log(`  3) both      — write to both\n`);

  const sinkAns = (await ask("Sink (1/2/3)", existing.sink === "markdown" ? "2" : existing.sink === "both" ? "3" : "1")).trim();
  const sink: JobSink = sinkAns === "2" ? "markdown" : sinkAns === "3" ? "both" : "airtable";

  let pat = existing.airtable?.pat ?? "";
  let baseId = existing.airtable?.baseId ?? "";
  let tableName = existing.airtable?.tableName ?? "Jobs";

  if (sink === "airtable" || sink === "both") {
    console.log(`\nDon't have an Airtable account yet? Sign up with this referral link`);
    console.log(`to get free credits (supports jobsync development):`);
    console.log(`  → https://airtable.com/invite/r/ONu6zRuH\n`);
    console.log(`Already signed up? Create a Personal Access Token at:`);
    console.log(`  → https://airtable.com/create/tokens\n`);
    console.log(`Required scopes:`);
    console.log(`  - data.records:read, data.records:write, schema.bases:read`);
    console.log(`  - schema.bases:write  (only if you want jobsync to create a base for you)`);
    console.log(`And under Access: add the workspace/base you want jobsync to use.\n`);
    pat = await ask("Airtable PAT", pat);
    if (!pat) {
      console.error("\nPAT is required when sink includes airtable. Aborting.");
      rl.close();
      process.exit(2);
    }

    const wantCreate = (await ask("Do you already have a base? (y=use existing, n=create one)", baseId ? "y" : "n")).toLowerCase().startsWith("y");
    if (wantCreate) {
      baseId = await ask("Airtable base ID (starts with app...)", baseId);
    } else {
      console.log(`\nFind your workspace ID from the URL when viewing a workspace: https://airtable.com/{wspId}/...`);
      const workspaceId = await ask("Airtable workspace ID (starts with wsp...)");
      if (!workspaceId) {
        console.error("Workspace ID required to create a base. Aborting.");
        rl.close();
        process.exit(2);
      }
      const baseName = await ask("Name for the new base", "JobSync");
      try {
        const bases = await listBases(pat);
        if (bases.find((b) => b.name === baseName)) {
          console.log(`(A base named "${baseName}" already exists — creating anyway; Airtable allows duplicates.)`);
        }
        console.log(`Creating base "${baseName}"...`);
        const result = await createJobSyncBase(pat, workspaceId, baseName);
        baseId = result.id;
        console.log(`✓ Created base ${baseId} → https://airtable.com/${baseId}`);
      } catch (err) {
        console.error(`\nFailed to create base: ${err instanceof Error ? err.message : String(err)}`);
        console.error(`Make sure your PAT has the \`schema.bases:write\` scope.`);
        rl.close();
        process.exit(2);
      }
    }
    tableName = await ask("Airtable table name", tableName);
  }

  const markdownPath = await ask(
    "Markdown output path",
    existing.markdownPath ?? `${process.env.HOME ?? process.env.USERPROFILE}/.jobsync/jobs.md`,
  );
  const lookbackHours = Number(await ask("Lookback hours", String(existing.lookbackHours ?? 12)));
  const usOnly = (await ask("US-only filter? (y/n)", existing.usOnly === false ? "n" : "y")).toLowerCase().startsWith("y");
  const enableFastPath = (await ask("Enable ATS fast-path fetchers? (y/n)", existing.enableFastPath ? "y" : "n")).toLowerCase().startsWith("y");
  const brandedOutput = (await ask("Show Coral Labs brand marker on each tool response? (y/n)", existing.brandedOutput === false ? "n" : "y")).toLowerCase().startsWith("y");

  rl.close();

  const cfg: JobSyncConfig = {
    airtable: { pat, baseId, tableName, fieldMap: existing.airtable?.fieldMap ?? {} },
    sink,
    markdownPath,
    lookbackHours: Number.isFinite(lookbackHours) ? lookbackHours : 12,
    usOnly,
    enableFastPath,
    profileDir: existing.profileDir ?? `${process.env.HOME ?? process.env.USERPROFILE}/.jobsync/profile`,
    brandedOutput,
    applyHumanize: existing.applyHumanize ?? DEFAULT_APPLY_HUMANIZE,
  };
  saveConfig(cfg);
  console.log(`\nSaved ${CONFIG_PATH}`);
  console.log(`\nNext:`);
  console.log(`  1. jobsync-mcp onboard --resume PATH    (parse your resume)`);
  console.log(`  2. jobsync-mcp print-client-config      (paste into your MCP client)`);
  console.log(`  3. Invoke the \`onboard_profile\` prompt in your MCP client to finalize the profile.`);
  printStarPrompt();
}

function printStarPrompt() {
  console.log(`
⭐  Enjoying jobsync-mcp? Star the repo to support development:
    https://github.com/Mayank-glitch-cpu/JobSync-Service
`);
}

const args = process.argv.slice(2);
const cmd = args[0];

function printClientConfig() {
  const snippet = {
    mcpServers: {
      jobsync: {
        command: "jobsync-mcp",
        args: [],
      },
    },
  };
  console.log(JSON.stringify(snippet, null, 2));
}

function help() {
  console.log(`jobsync-mcp — agentic job-aggregation MCP server

Usage:
  jobsync-mcp                         Start the MCP server (stdio transport)
  jobsync-mcp init                    Interactive config wizard (not yet implemented)
  jobsync-mcp onboard --resume PATH   Onboarding / resume extraction (not yet implemented)
  jobsync-mcp print-client-config     Emit MCP client config snippet
  jobsync-mcp status                  Show current config path and status
  jobsync-mcp help                    Show this message
`);
}

async function main() {
  printBanner();
  switch (cmd) {
    case undefined:
    case "serve":
      await import("./index.js");
      return;
    case "print-client-config":
      printClientConfig();
      return;
    case "status":
      console.log(`Config path: ${CONFIG_PATH}`);
      console.log(`Config exists: ${configExists()}`);
      return;
    case "onboard": {
      const resumeIdx = args.indexOf("--resume");
      if (resumeIdx === -1 || !args[resumeIdx + 1]) {
        console.error("Usage: jobsync-mcp onboard --resume PATH\n");
        console.error("Supported formats: .pdf, .docx, .txt, .md");
        process.exit(2);
      }
      const path = args[resumeIdx + 1]!;
      ensureProfileDir();
      const text = await parseResume(path);
      writeRawResume(text);
      console.log(`Parsed resume: ${text.length} chars extracted.`);
      console.log(`Saved to: ${rawResumePath()}`);
      console.log(`\nNext step: open your MCP client (Claude Desktop, Claude Code, Cursor) and invoke the`);
      console.log(`\`onboard_profile\` prompt. The agent will structure your resume into skills.md,`);
      console.log(`experience.md, projects.md and suggest target roles for you to confirm.`);
      printStarPrompt();
      return;
    }
    case "init":
      await runInit();
      return;
    case "help":
    case "--help":
    case "-h":
      help();
      return;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      help();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
