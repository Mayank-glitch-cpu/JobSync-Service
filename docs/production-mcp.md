# JobSync MCP Production Deployment

This repo now supports two MCP transports:

- Local stdio: `jobsync-mcp` or `node dist/index.js`
- Remote Streamable HTTP: `node dist/http.js` at `/mcp`

Use the remote transport when Claude needs to connect to JobSync from the cloud.

## Minimum Production Shape

1. Deploy `mcp-server` as a Node web service.
2. Expose HTTPS publicly.
3. Set Airtable and JobSync environment variables.
4. Add `https://YOUR_DOMAIN/mcp` as a custom connector in Claude, or pass it through the Claude Messages API MCP connector.

The HTTP server also exposes:

- `GET /healthz` for uptime checks
- `POST /mcp` and `GET /mcp` for MCP Streamable HTTP

## Required Environment Variables

```bash
NODE_VERSION=22.11.0
PORT=3000
JOBSYNC_SINK=airtable
AIRTABLE_API_KEY=pat...
AIRTABLE_BASE_ID=app...
AIRTABLE_TABLE_NAME=Jobs
```

Optional:

```bash
JOBSYNC_REMOTE_BEARER_TOKEN=long-random-secret
JOBSYNC_LOOKBACK_HOURS=24
JOBSYNC_US_ONLY=true
JOBSYNC_ENABLE_FAST_PATH=false
JOBSYNC_BRANDED_OUTPUT=true
```

If `JOBSYNC_REMOTE_BEARER_TOKEN` is set, every MCP request must include:

```http
Authorization: Bearer long-random-secret
```

That is useful for private API usage and testing. For Claude.ai custom connectors with real user sign-in, implement OAuth instead of static bearer auth.

## Render

`render.yaml` is configured for this service:

```bash
corepack enable && pnpm install --frozen-lockfile && pnpm --filter jobsync-mcp build
cd mcp-server && node dist/http.js
```

After deploy, verify:

```bash
curl https://YOUR_RENDER_SERVICE.onrender.com/healthz
```

Then test MCP with the inspector:

```bash
npx @modelcontextprotocol/inspector
```

Choose Streamable HTTP and enter:

```text
https://YOUR_RENDER_SERVICE.onrender.com/mcp
```

## Claude Connections

### Claude.ai / Claude Desktop / Claude Mobile / Claude Code

Add a custom connector with:

```text
https://YOUR_DOMAIN/mcp
```

Claude custom connectors support authless servers and OAuth-based servers. They do not currently support users pasting static bearer tokens as the connector auth mechanism, so production multi-user sign-in should be OAuth.

### Claude Messages API

The Claude API can connect directly to a remote MCP server with `mcp_servers` and can pass an `authorization_token` when your server requires one.

```json
{
  "mcp_servers": [
    {
      "type": "url",
      "url": "https://YOUR_DOMAIN/mcp",
      "name": "jobsync",
      "authorization_token": "YOUR_ACCESS_TOKEN"
    }
  ],
  "tools": [
    {
      "type": "mcp_toolset",
      "mcp_server_name": "jobsync"
    }
  ]
}
```

## What Still Needs OAuth For Real Users

This deployment is production-capable for a private, single-tenant service. To let many users sign in and have isolated agents, add:

1. OAuth authorization server endpoints: discovery metadata, `/authorize`, `/token`, refresh-token rotation, and consent.
2. Per-user storage for Airtable credentials, profile files, cache state, and agent settings.
3. Request auth that maps each access token to the correct user workspace.
4. Admin UI for managing users, connected Airtable bases, allowed tools, and logs.
5. Audit logs and rate limits around write tools such as `airtable_upsert_job`.

Until that layer exists, do not run this as an open public connector with shared Airtable credentials.

## Storage Backend (Cache + App State)

jobsync persists three things: the dedup cache (seen job URLs), a TTL cache of
expensive MCP tool responses (`fetch_*`, link checks), and app state
(pipeline/profile/portals). Two backends are available, selected by
`JOBSYNC_STORAGE_BACKEND`:

| Backend | Storage | When to use |
| --- | --- | --- |
| `local` (default) | SQLite + files under `~/.jobsync` | stdio installs on a persistent machine |
| `firestore` | GCP Firestore | Cloud Run / any ephemeral, scale-to-zero host |

**Why this matters in the cloud:** Cloud Run's filesystem is ephemeral and
scales to zero, so a `local` backend loses all cache and pipeline state on every
cold start. Set `JOBSYNC_STORAGE_BACKEND=firestore` (auto-enabled when the
`K_SERVICE` env var is present) so state persists.

Firestore options:

- `GOOGLE_CLOUD_PROJECT` — project id (auto-detected from ADC on Cloud Run).
- `FIRESTORE_DATABASE_ID` — only if not using the `(default)` database.
- `JOBSYNC_RESPONSE_CACHE_TTL_HOURS` — response-cache TTL (default 6).

Collections used: `seen_jobs`, `mcp_cache` (with an `expiresAt` TTL policy), and
`jobsync_docs`. The runtime service account needs `roles/datastore.user`.

## Dashboard + User Auth (Firebase)

The server also hosts a self-serve **dashboard** (a React SPA in `dashboard/`,
served by `http.js` from `./public`). Users sign up with email + password via
**Firebase Auth**; the SPA sends the Firebase ID token as a bearer token and the
server verifies it with `firebase-admin` ([lib/firebase-auth.ts](../mcp-server/src/lib/firebase-auth.ts)).
Every `/api/*` dashboard route is per-user — the uid comes from the verified token,
and pipeline/runs are scoped to it. `/mcp` keeps its own bearer-token auth.

One-time setup (project `jobsync-mcp`):

1. Enable Firebase Auth (Identity Platform) and add the **Email/Password** provider:
   - In the [Firebase console](https://console.firebase.google.com/), add Firebase
     to the GCP project, then Authentication → Sign-in method → enable Email/Password.
2. Create a **Web app** in Firebase project settings and copy its `apiKey`.
3. Set `FIREBASE_API_KEY` (the web apiKey — public, not a secret) in the Cloud Run
   env. `FIREBASE_PROJECT_ID` defaults to `GOOGLE_CLOUD_PROJECT`; `authDomain`
   defaults to `<project>.firebaseapp.com`.

`firebase-admin` verifies tokens using Google's public certs over ADC — the runtime
service account needs no extra role. User records and pipelines live in Firestore
(already provisioned). Routes: `GET /api/config` (public web config), `GET /api/me`,
`GET /api/pipeline`, `PATCH /api/pipeline/:id`, `GET /api/agents`, `GET|POST /api/runs`.

> Note: running the Search/Auto-Apply agents server-side from the dashboard is the
> next phase; today the agent cards record a queued run but don't execute.

## Google Cloud Run

For GCP, use Cloud Run with the included root `Dockerfile`. The `gcp-deploy.sh`
script provisions Firestore (enables the API, creates the `(default)` database,
sets the `mcp_cache` TTL policy, and grants `roles/datastore.user`) before
deploying.

```bash
./gcp-deploy.sh
# or, manually:
gcloud run deploy jobsync-mcp --source . --region us-central1 --allow-unauthenticated --port 3000 \
  --set-env-vars JOBSYNC_STORAGE_BACKEND=firestore
```

See `docs/gcp-cloud-run.md` for the full secret-backed deployment flow.
