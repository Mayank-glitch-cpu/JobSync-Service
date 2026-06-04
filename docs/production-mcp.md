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

## Google Cloud Run

For GCP, use Cloud Run with the included root `Dockerfile`.

```bash
gcloud run deploy jobsync-mcp --source . --region us-central1 --allow-unauthenticated --port 3000
```

See `docs/gcp-cloud-run.md` for the full secret-backed deployment flow.
