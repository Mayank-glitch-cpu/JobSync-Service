# Changelog

All notable changes to `jobsync-mcp` are documented here.

Format: [Semantic Versioning](https://semver.org). Each release is tagged `v{version}` on GitHub with a matching release note.

---

## [0.2.6] — upcoming
- TBD

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
