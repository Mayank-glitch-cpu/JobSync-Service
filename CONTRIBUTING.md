# Contributing to JobSync

Thanks for helping improve JobSync. This project is an agentic job-search MCP server plus supporting docs and archived legacy apps. Contributions are welcome, especially bug fixes, MCP tool improvements, tests, documentation, and clearer onboarding flows.

## Project Areas

- `mcp-server/` - the published `jobsync-mcp` npm package. Most active development happens here.
- `docs/` - static docs, landing pages, demos, and GitHub Pages assets.
- `legacy/` - the original backend/frontend implementation. Keep changes here focused unless you are fixing a legacy-specific issue.

## Before You Start

1. Open an issue for larger changes so the approach can be discussed first.
2. Keep pull requests focused. Small PRs are much easier to review.
3. Do not commit secrets, Airtable tokens, resumes, local config files, or personal job-search data.
4. Avoid committing generated artifacts unless the change is specifically about docs/media assets.

## Local Setup

Requirements:

- Node.js `>=22.5.0` for `mcp-server/` because it uses `node:sqlite`.
- npm.

Install dependencies for the MCP server:

```bash
cd mcp-server
npm install
```

If you need the legacy dashboard:

```bash
npm run install:all
npm run dev
```

## Development Workflow

Use a branch name that describes the work:

```bash
git checkout -b fix/cache-dedup-edge-case
git checkout -b docs/setup-walkthrough
git checkout -b feat/markdown-sink-option
```

For MCP server changes, run:

```bash
cd mcp-server
npm run typecheck
npm test
npm run build
```

For docs-only HTML/CSS changes, verify the page locally in a browser and check that relative links and assets resolve from the `docs/` directory.

## Coding Guidelines

- Prefer the existing TypeScript patterns in `mcp-server/src`.
- Keep MCP tools deterministic where possible. The client model should do semantic reasoning; the server should handle filtering, parsing, persistence, and reliable plumbing.
- Validate external input with existing schema patterns, especially for tools exposed through MCP.
- Add or update tests when changing filtering, deduplication, Airtable sync, profile parsing, or other shared behavior.
- Keep user-facing messages clear and actionable.
- Preserve backward compatibility for config fields under `~/.jobsync/` when feasible.

## Testing Guidance

Good PRs include at least one of:

- A unit test for new filtering, parsing, or utility logic.
- A regression test for a fixed bug.
- Manual verification notes for docs, CLI, or MCP-client behavior.

When testing Airtable-related changes, do not include real PATs, base IDs, workspace IDs, or screenshots that expose private data.

## Documentation Changes

Update docs when you change:

- CLI commands or flags.
- MCP tool names, arguments, or outputs.
- Config keys in `~/.jobsync/config.json`.
- Setup, onboarding, Airtable sync, markdown sink, or troubleshooting behavior.

The main technical docs live in:

- `README.md`
- `mcp-server/README.md`
- `docs/jobsync-mcp-technical.html`

## Pull Request Checklist

Before opening a PR:

- The change is scoped to one problem or feature.
- `npm run typecheck`, `npm test`, and `npm run build` pass in `mcp-server/` when code changes are made.
- Docs are updated for behavior or command changes.
- No secrets, personal data, local paths, or generated caches are included.
- The PR description explains what changed and how it was verified.

## Security

Please do not open a public issue for vulnerabilities that expose tokens, private Airtable data, local profile files, or command execution risks. Instead, contact the maintainer privately through the repository owner profile and include enough detail to reproduce the issue safely.

## Review Expectations

Maintainers may ask for smaller scope, more tests, clearer docs, or changes that better match the MCP architecture. That is normal. The goal is a project that stays useful, portable, and safe for people running it against their own job-search data.

