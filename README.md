# JobSync — Agentic Job Aggregation

An agentic job-search copilot that uses your own MCP client (Claude Desktop, Claude Code, Cursor) to discover, classify, and sync fresh job postings into your own Airtable base — or a local markdown file. Model-agnostic: you bring the LLM, JobSync handles the plumbing.

[![Watch the demo](https://img.youtube.com/vi/3Zf3c3PXHvc/maxresdefault.jpg)](https://www.youtube.com/watch?v=3Zf3c3PXHvc)

---

## How it works

The MCP server exposes deterministic tools (filters, classifiers, dedup, Airtable/Markdown sinks, profile I/O). Your MCP client's model drives the full workflow:

```
Profile (roles.json)
       ↓
web_search  →  web_fetch  →  classify_job_batch  →  cache_is_seen  →  airtable_upsert_job / markdown_append_jobs
                                                                              ↓
                                                                       cache_mark_seen
```

No hardcoded API keys. No Anthropic SDK in the server. The agent is your MCP client.

---

## Install

```bash
npm i -g jobsync-mcp
jobsync-mcp init
jobsync-mcp onboard --resume /path/to/resume.pdf
```

Requires **Node >= 22.5**.

---

## `jobsync-mcp init` — Configure

The wizard asks:

**Sink** — where should jobs land?
- `airtable` — your own Airtable base (full schema, queryable)
- `markdown` — append to `~/.jobsync/jobs.md` (no Airtable needed)
- `both`

**If Airtable:** create a PAT at https://airtable.com/create/tokens
*(Don't have an account? Use https://airtable.com/invite/r/ONu6zRuH for free credits)*

Required PAT scopes: `data.records:read`, `data.records:write`, `schema.bases:read`
Add `schema.bases:write` if you want the wizard to **create the base for you** (it creates the full Jobs table with all fields pre-configured).

**Other:** lookback hours (default 12), US-only filter (default on), fast-path ATS fetchers (default off).

Config saved to `~/.jobsync/config.json`.

---

## Register with your MCP client

### Claude Code

```bash
claude mcp add --scope user jobsync jobsync-mcp
claude mcp list   # expect: jobsync: jobsync-mcp  - ✓ Connected
```

`--scope user` makes it available in every project. If `jobsync-mcp` isn't on PATH:

```bash
where jobsync-mcp   # Windows
which jobsync-mcp   # macOS/Linux

claude mcp add --scope user jobsync "C:\Users\you\AppData\Roaming\npm\jobsync-mcp.cmd"
```

### Claude Desktop / Cursor

```bash
jobsync-mcp print-client-config
```

Paste the output into:
- **Claude Desktop (macOS):** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Claude Desktop (Windows):** `%APPDATA%\Claude\claude_desktop_config.json`
- **Cursor:** `~/.cursor/mcp.json`

---

## Run the prompts

### One-time onboarding

```
/mcp__jobsync__onboard_profile
```

Reads `raw-resume.txt`, writes `skills.md` / `experience.md` / `projects.md`, proposes detected roles, asks you to confirm. Files are editable at `~/.jobsync/profile/` any time.

### Primary workflow

```
/mcp__jobsync__scrape_jobs_workflow
```

Optional args: `companies=Anthropic,Stripe` · `roleKeywordsOverride=SDE` · `lookbackHours=48`

---

## `~/.jobsync/` layout

```
~/.jobsync/
├── config.json
├── cache.db             # SQLite dedup
├── jobs.md              # markdown sink (if enabled)
└── profile/
    ├── skills.md
    ├── experience.md
    ├── projects.md
    ├── roles.json       # { detected, custom, excluded }
    └── raw-resume.txt
```

---

## Tools exposed to the agent

| Tool | Purpose |
|---|---|
| `classify_job_batch` | US filter + title keywords + industry/tags/H1B in one call |
| `airtable_upsert_job` | Batch upsert to Airtable |
| `airtable_create_base` | Auto-create base with full JobSync schema |
| `markdown_append_jobs` | Append jobs to local markdown file |
| `cache_is_seen` / `cache_mark_seen` | SQLite hybrid dedup |
| `profile_read` / `profile_update_roles` | Profile I/O |
| `fetch_greenhouse_jobs` / `fetch_lever_jobs` / `fetch_ashby_jobs` | ATS fast-path (flag-gated) |

Full tool list: [mcp-server/README.md](mcp-server/README.md)

---

## As a cron job

```bash
# Windows Task Scheduler / Unix cron
claude -p "invoke scrape_jobs_workflow from jobsync with lookbackHours=24"
```

---

## Troubleshooting

- **`node:sqlite` not found** — upgrade to Node 22.5+
- **`claude mcp list` shows "Not connected"** — re-register with the absolute path (see above)
- **Airtable 403 on base creation** — PAT missing `schema.bases:write` scope; also ensure the workspace is added under Access when creating the PAT
- **0 new jobs** — search indexes lag; widen `lookbackHours` to 72+, or enable `enableFastPath` and use the direct ATS fetchers

---

## Project structure

```
JobsList/
├── mcp-server/        # Published npm package: jobsync-mcp
│   ├── src/
│   │   ├── tools/     # MCP tool definitions
│   │   ├── prompts/   # scrape_jobs_workflow, onboard_profile, extract_job_fields
│   │   ├── lib/       # filter, airtable, cache, profile, tags, fast-path, markdown sink
│   │   └── config.ts  # ~/.jobsync/config.json loader
│   └── bin/
└── legacy/            # Archived original Fastify backend + React frontend
    ├── backend/       # 25+ ATS fetchers, Anthropic SDK pipeline
    └── frontend/      # React dashboard
```

The legacy system remains runnable — see [legacy/backend/](legacy/backend/) for the original Fastify + Claude SDK pipeline.

---

## License

MIT
