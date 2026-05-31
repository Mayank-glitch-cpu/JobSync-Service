# jobsync-mcp

Agentic job-aggregation MCP server. Any MCP client (Claude Desktop, Claude Code, Cursor) loads it, and **the client's own model** drives discovery via `web_search` + `web_fetch`. This server exposes deterministic helpers — filters, classifiers, SQLite dedup, Airtable / Markdown sinks, profile I/O — plus prompt templates that encode the full scraping workflow.

Model-agnostic. You bring the LLM; we handle the plumbing.

---

## Requirements

- **Node >= 22.5** (uses built-in `node:sqlite`)
- An MCP client with `web_search` and `web_fetch` tools (Claude Desktop / Claude Code have these)
- Optional: an Airtable Personal Access Token — **or** skip Airtable entirely and use the markdown sink

---

## Quick start

```bash
# 1. Configure (interactive wizard — uses npx, no global install needed)
npx -y jobsync-mcp@latest init

# 2. Parse your resume
npx -y jobsync-mcp@latest onboard --resume /path/to/resume.pdf

# 3. Register with your MCP client (see below)

# 4. In your client, invoke the onboarding prompt, then the scrape workflow
```

---

## Step 2 — `jobsync-mcp init`

The wizard walks through:

### Sink
Where should new jobs land?
- **`airtable`** — your own Airtable base (full schema, queryable)
- **`markdown`** — append to a local markdown file (no Airtable account needed)
- **`both`**

### If you picked Airtable

Create a PAT at https://airtable.com/create/tokens with these scopes:
- `data.records:read`
- `data.records:write`
- `schema.bases:read`
- `schema.bases:write` *(only if you want jobsync to create a new base for you)*

The wizard then asks:
- **Do you already have a base?**
  - **Yes** → paste its base ID (`app…`)
  - **No** → paste your workspace ID (`wsp…`, visible in the Airtable URL when viewing a workspace), and the wizard creates a new `JobSync` base with the full Jobs table schema for you.

### Other options
- **Markdown output path** — default `~/.jobsync/jobs.md`
- **Lookback hours** — how fresh jobs must be (default 12)
- **US-only filter** (default yes)
- **Enable ATS fast-path fetchers** — direct job-board API calls for high-volume reliable pulls (default off; the agentic path is the default)
- **Branded tool output** — prefix every jobsync tool response with the Coral Labs marker (`🪸 jobsync · Coral Labs`). Default on; set `brandedOutput: false` in `~/.jobsync/config.json` to silence it.

Config is written to `~/.jobsync/config.json`.

---

## Step 3 — `jobsync-mcp onboard --resume PATH`

Parses your resume (PDF / DOCX / TXT / MD) and saves the raw text to `~/.jobsync/profile/raw-resume.txt`. The structuring into `skills.md`, `experience.md`, `projects.md` happens in Step 5 via the MCP prompt — driven by *your* client's model.

---

## Step 4 — Register with your MCP client

### Claude Code (recommended)

```bash
claude mcp add --scope user jobsync npx -- -y jobsync-mcp@latest server
claude mcp list        # expect: jobsync: npx  - ✓ Connected
```

The `--scope user` flag makes it available in **every** project. No global install needed — npx always pulls the latest published version when Claude Code starts.

### Claude Desktop / Cursor

Add this block to your config file manually:

```json
{
  "mcpServers": {
    "jobsync": {
      "command": "npx",
      "args": ["-y", "jobsync-mcp@latest", "server"]
    }
  }
}
```

- **Claude Desktop** — `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows)
- **Cursor** — `~/.cursor/mcp.json`

Restart the client.

---

## Step 5 — Run the prompts inside your client

### Onboarding (one time)

In a Claude Code session:

```
/mcp__jobsync__onboard_profile
```

The agent will:
1. Read `raw-resume.txt`
2. Write `skills.md`, `experience.md`, `projects.md` via `profile_write_file`
3. Propose 3–7 target roles and ask you to confirm / add custom / exclude any

Edit any file in `~/.jobsync/profile/` by hand later — the agent re-reads them every run.

### Primary workflow

```
/mcp__jobsync__scrape_jobs_workflow
```

Optional args:
- `companies=Anthropic,Stripe` — prioritize these
- `roleKeywordsOverride=SDE,Backend Engineer` — one-off override, ignoring profile
- `lookbackHours=48` — widen/tighten the recency window

The agent runs: `profile_read` → `web_search` → `web_fetch` → `classify_job_batch` → `cache_is_seen` (+ `airtable_list_recent_jobs` fallback) → `airtable_upsert_job` **or** `markdown_append_jobs` (per your sink) → `cache_mark_seen`.

---

## `~/.jobsync/` layout

```
~/.jobsync/
├── config.json
├── cache.db             # SQLite dedup cache
├── jobs.md              # markdown sink (if enabled)
└── profile/
    ├── skills.md        # editable
    ├── experience.md    # editable
    ├── projects.md      # editable
    ├── roles.json       # { detected, custom, excluded }
    └── raw-resume.txt
```

---

## Tools

| Tool | Purpose |
|---|---|
| `jobsync_ping` | Sanity check |
| `filter_us_location` | Drop non-US postings |
| `filter_title_keywords` | Keyword match on titles |
| `detect_industry_tags` | Industry + FAANG+ / YC / H1B tags |
| `classify_job_batch` | All filters + tags in one call |
| `airtable_upsert_job` | Batch upsert into user's base |
| `airtable_list_recent_jobs` | Dedup fallback |
| `airtable_get_schema` | Inspect base/table + active config |
| `airtable_list_bases` | List bases the PAT can access |
| `airtable_create_base` | Create a new base with the JobSync schema |
| `markdown_append_jobs` | Append jobs to the markdown log |
| `cache_is_seen` | SQLite dedup lookup |
| `cache_mark_seen` | Mark as seen after upsert |
| `cache_prune` | TTL-based cache trim |
| `profile_read` | Load skills / experience / projects / roles |
| `profile_write_file` | Overwrite a profile markdown file |
| `profile_update_roles` | Mutate detected / custom / excluded |
| `profile_parse_resume` | PDF / DOCX / TXT → raw text |
| `fetch_greenhouse_jobs` | ATS fast-path (flag-gated) |
| `fetch_lever_jobs` | ATS fast-path (flag-gated) |
| `fetch_ashby_jobs` | ATS fast-path (flag-gated) |
| `ashby_get_date_posted` | Scrape real `datePosted` from an Ashby job page's JSON-LD |
| `ashby_get_date_posted_batch` | Batch version with optional `lookbackHours` filter |
| `verify_job_link` | Check if a job URL still resolves to a live posting |
| `verify_job_link_batch` | Batch link verification (max 20) |

## Prompts

- **`onboard_profile`** — one-time resume structuring + role selection
- **`scrape_jobs_workflow`** — primary loop
- **`extract_job_fields`** — per-posting extraction helper

## Resources

- **`prompts://extraction-schema`** — field schema the extraction prompt targets

---

## CLI

```
jobsync-mcp                         Start the MCP server (stdio)
jobsync-mcp init                    Interactive config wizard
jobsync-mcp onboard --resume PATH   Parse a resume (.pdf / .docx / .txt / .md)
jobsync-mcp print-client-config     Emit MCP client JSON snippet
jobsync-mcp status                  Show config path + existence
```

---

## Remote / cloud deployment

The package also builds a Streamable HTTP transport for remote MCP hosting:

```bash
pnpm --filter jobsync-mcp build
cd mcp-server
PORT=3000 node dist/http.js
```

Remote endpoint:

```text
https://YOUR_DOMAIN/mcp
```

Health check:

```text
https://YOUR_DOMAIN/healthz
```

For cloud deploys, configure with environment variables instead of `~/.jobsync/config.json`:

```bash
AIRTABLE_API_KEY=pat...
AIRTABLE_BASE_ID=app...
AIRTABLE_TABLE_NAME=Jobs
JOBSYNC_SINK=airtable
```

Set `JOBSYNC_REMOTE_BEARER_TOKEN` for private bearer-token protection. For Claude.ai custom connectors with user sign-in, use OAuth; see `docs/production-mcp.md`.

---

## Running as a cron job

The server is just a stdio MCP peer — scheduling is the client's job. With Claude Code, drop this in your crontab / Task Scheduler:

```
claude -p "invoke the scrape_jobs_workflow prompt from jobsync with lookbackHours=24"
```

---

## Troubleshooting

- **`node:sqlite` not found** — you're on Node <22.5. Upgrade Node.
- **`claude mcp list` shows "Not connected"** — verify `jobsync-mcp` is on PATH (`where jobsync-mcp` / `which jobsync-mcp`). Re-register with the absolute path if needed.
- **Airtable 403 on `airtable_create_base`** — PAT is missing the `schema.bases:write` scope. Regenerate.
- **0 new jobs on every run** — search indexes lag; your `lookbackHours` window is too tight. Widen to 48–72, or enable `enableFastPath` and use `fetch_ashby_jobs` / `fetch_greenhouse_jobs` / `fetch_lever_jobs` against known company slugs.
- **"Unknown skill" for slash command** — your `/mcp__jobsync__...` form isn't supported in your Claude Code version. Either select the prompt from the `/mcp` menu, or just ask in plain English: *"run the onboard_profile prompt from jobsync."*

---

## License

MIT
