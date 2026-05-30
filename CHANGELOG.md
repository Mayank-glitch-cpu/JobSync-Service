# Changelog

All notable changes to `jobsync-mcp` are documented here.

Format: [Semantic Versioning](https://semver.org). Each release is tagged `v{version}` on GitHub with a matching release note.

---

## [0.8.16] — 2026-05-30

### Added
- **`apply_fill_fields` tool** — given an inspected form and the user's personal profile, maps standard fields, identifies essay/free-text fields, and saves the draft via `apply_save_draft`. Returns a Markdown preview table plus an essay-generation block so Claude can author tailored answers. Accepts optional `company` and `jobTitle` to personalise AI-generated essay responses.
- **AI field-fill library** (`src/lib/ai-fill.ts`) — `mapStandardFields`, `identifyEssayFields`, `identifyUnansweredFields`, `buildEssayPromptBlock`, `buildAnswerPromptBlock`, and `fillFields`, plus a canonical exported `ESSAY_PATTERNS` list used across the apply tools.
- **Preview table with unfilled-required tracking** — `apply_save_draft` now renders a preview table and surfaces required fields that no instruction targets, re-derived from live form state instead of a hardcoded empty list.

### Fixed
- **Two-pass scroll for form detection** — browser apply now scrolls to the bottom to trigger lazy-loaded content, then returns to the top before extracting fields, so dynamically rendered inputs are detected.
- **Resume upload confirmation** — replaced the fixed 1 s sleep with a poll (up to 2 s) on `files.length`, and warns when the upload can't be confirmed.
- **Iframe application detection** — uses a path-boundary match for `/application` so unrelated URLs no longer trigger the iframe path.
- **Work-authorization handling** — flipped from a leaky denylist to an explicit allowlist; dropped the over-broad `/interest/i` essay pattern.
- **Selector resolution** — `testid` / `aria-label` selector now uses a ternary instead of an always-left `||`.

---

## [0.8.2] — 2026-04-23

### Fixed
- **Fit analysis table missing apply links** — `scrape_jobs_workflow` Step 9 now enforces the exact table column format (`Score | Role | Company | Location | Date Posted | Manual Apply | Agentic Apply`). Previously Claude substituted a `Why` column and dropped the `[Apply ↗](url)` link.
- **Scored jobs not persisted to pipeline** — Step 9 and `analyze_job_fit` Step 4 both now explicitly require `pipeline_upsert_jobs` to be called after the fit table is rendered. The previous wording ("follow the full analyze_job_fit steps") was too vague and Claude skipped the upsert, leaving the pipeline dashboard empty after a scrape run.

---

## [0.7.0] — 2026-04-20

### Added
- **`fetch_workday_jobs` tool** — fast-path fetcher for Workday ATS boards via the public CXS API (`POST /wday/cxs/{tenant}/{board}/jobs`). Accepts a full board URL (e.g. `https://microsoft.wd1.myworkdayjobs.com/en-US/External`) or a batch via `boardUrls`. Paginates automatically (20 per page, capped at 200). Returns `rawFields.postedOn` (e.g. "Posted 3 days ago") for recency filtering since Workday does not expose `datePosted` in its API.
- **Workday link verification** in `verify_job_link` and `verify_job_link_batch` — detects `myworkdayjobs.com` URLs, fetches the job page, and scans for Workday-specific closed-job language alongside the existing generic soft-close patterns.
- **Workday search query in `scrape_jobs_workflow`** — Step 2 now includes `site:myworkdayjobs.com <role> entry level USA <year>` alongside Greenhouse / Lever / Ashby queries.

### Notes
- Workday's CXS API is undocumented but publicly accessible; behavior may vary by tenant configuration.
- `datePosted` will always be `null` for Workday jobs — use `rawFields.postedOn` to gauge recency until a scraping approach for individual job pages is added.

---

## [0.6.0] — 2026-04-20

### Added
- **`suggest_model_for_query` tool** — advisory tool that recommends the optimal Claude model tier (haiku / sonnet / opus) for a given query, workflow context, or named tool call. Returns `{ recommended, genericTier, anthropicModel, reason, estimatedTokensSaved }`. Accepts optional `context` (`scrape | onboarding | classification | extraction | freeform`) and `toolName` for static per-tool lookups.
- **`recommendedModel` metadata on every tool** — each `ToolDefinition` now carries an optional `recommendedModel: "haiku" | "sonnet" | "opus"` field, and every tool description includes a `⚡/⚖/🔬 [Model hint: ...]` suffix so MCP clients can surface the recommendation without calling the advisor.
- **Model-tier preamble in `scrape_jobs_workflow`** — the prompt now opens with a step-by-step tier table (Steps 0,1,4–8 → haiku; Steps 2–3 → sonnet; onboarding → opus) and explicit `/model` switching instructions for Claude Code clients.

### Tier mapping
| Tier | Tools |
|---|---|
| haiku | `jobsync_ping`, `cache_*`, `filter_*`, `airtable_list_*`, `airtable_get_schema`, `airtable_create_base`, `markdown_append_jobs`, `verify_job_link*`, `ashby_get_date_posted*`, `fetch_*_jobs`, `profile_read`, `profile_write_file` |
| sonnet | `classify_job_batch`, `detect_industry_tags`, `profile_parse_resume`, `airtable_upsert_job` |
| opus | `profile_update_roles` |

---

## [0.5.0] — 2026-04-16

### Added
- **Coral Labs branding on every tool response** — `textResult` and `errorResult` now prepend a `🪸 jobsync · Coral Labs` content block to all tool results when `brandedOutput: true` (default on)
- **`brandedOutput` config flag** — set to `false` in `~/.jobsync/config.json` to silence the brand prefix; `init` wizard now asks for this preference
- **Shared brand module** (`src/lib/brand.ts`) — single source of truth for the Coral Labs logo, one-line marker, and `brandPrefix()` helper; CLI banner now imports from here
- **Branding rule in workflow prompts** — `scrape_jobs_workflow` and `onboard_profile` prompts instruct Claude to open every user-facing message with `🪸 jobsync · Coral Labs`

### Changed
- CLI `printBanner()` refactored to use `BRAND_LOGO_BANNER` from the shared brand module

---

## [0.4.0] — 2026-04-16

### Added
- **`ashby_get_date_posted`** — scrapes an Ashby job page's embedded JSON-LD to extract the real `datePosted` (Ashby's posting-api returns `null` for this field)
- **`ashby_get_date_posted_batch`** — batch version (up to 20 URLs); accepts optional `lookbackHours` to flag each result `withinLookback: true/false` for recency filtering
- **Step 5b in `scrape_jobs_workflow`** — after link verification, agent calls `ashby_get_date_posted_batch` on all Ashby URLs, drops postings outside the lookback window, and overwrites `datePosted` before upsert

---

## [0.3.0] — 2026-04-15

### Changed
- License changed to MIT; `package.json` license field updated to `"MIT"`
- LICENSE file updated with full MIT license text (copyright: Coral Labs & Mayank-glitch-cpu)

---

## [0.2.9] — 2026-04-15

### Changed
- Reordered CLI banner: JobSync info first, Coral Labs section below

---

## [0.2.8] — 2026-04-15

### Added
- Coral Labs branding in CLI banner (website, mentor Vivek Gupta, updated copyright)

---

## [0.2.7] — 2026-04-15
### Added
- CLI banner on every `jobsync-mcp` command — Coral Labs branding, website, mentor (Vivek Gupta), author, GitHub link, and copyright notice
- `LICENSE` file: proprietary / All Rights Reserved — Coral Labs & Mayank-glitch-cpu
- `package.json` license field changed from `"MIT"` to `"UNLICENSED"`

---

## [0.2.6] — 2026-04-14
### Changed
- Enhanced `jobsync_ping` tool with npm registry check, `updateAvailable` flag, and `changelog` URL

---

## [0.2.5] — 2026-04-14
### Added
- `jobsync_ping` now checks the npm registry and returns `updateAvailable`, `latestVersion`, and `changelog` URL
- `scrape_jobs_workflow` prompt calls ping at Step 0 and stops to notify the user if an update is available
- `verify_job_link` + `verify_job_link_batch` tools — validates Greenhouse/Lever/Ashby links via board APIs; generic fallback scans for soft-close language
- Updated repo link to https://github.com/Mayank-glitch-cpu/JobSync-Service

---

## [0.2.4] — 2026-04-14
### Added
- Version strings (`jobsync_ping`, MCP server metadata) updated to track `package.json`
### Fixed
- `classify_job_batch` now passes `jobDescription`, `location`, and `applyLink` through to output — previously these were consumed internally and dropped, causing job descriptions to be missing in Airtable

---

## [0.2.3] — 2026-04-14
### Fixed
- `classify_job_batch` job description pass-through (partial fix; completed in 0.2.4)

---

## [0.2.2] — 2026-04-14
### Added
- Airtable referral link shown in `jobsync-mcp init` for new signups
- GitHub star prompt shown after `init` and `onboard` commands
- `init` wizard now clarifies PAT workspace Access requirement (separate from scope)

---

## [0.2.1] — 2026-04-14
### Fixed
- `engines.node` tightened to `>=22.5.0` (was `>=20.0.0`); Node 20/21 users now get a clear install error instead of a runtime crash on `node:sqlite`
### Docs
- Full README rewrite: step-by-step install, Claude Code integration, troubleshooting section

---

## [0.2.0] — 2026-04-14
### Added
- **Markdown sink** — `markdown_append_jobs` tool + `sink: "airtable" | "markdown" | "both"` config key; Airtable is now optional
- **Airtable base auto-create** — `airtable_create_base` tool creates a new base with the full Jobs schema via Airtable Meta API (requires `schema.bases:write` scope)
- **`airtable_list_bases`** — lists all bases the PAT can access
- `init` wizard redesigned: asks for sink first, guides through base creation or existing base ID
- Config gains `markdownPath` (default `~/.jobsync/jobs.md`)
- `scrape_jobs_workflow` prompt routes to correct sink based on config

---

## [0.1.0] — 2026-04-13
### Initial release
- Stdio MCP server with 15 tools: filter, classify, Airtable upsert/list/schema, SQLite dedup cache, profile I/O, fast-path ATS fetchers (Greenhouse/Lever/Ashby, flag-gated)
- Prompts: `scrape_jobs_workflow`, `onboard_profile`, `extract_job_fields`
- Resource: `prompts://extraction-schema`
- CLI: `init`, `onboard`, `status`, `print-client-config`
- User profile: resume parser (PDF/DOCX/TXT/MD), skills/experience/projects markdown, roles.json with detected/custom/excluded lists
