# Deploy JobSync MCP To Google Cloud Run

Cloud Run is the recommended first GCP target for JobSync MCP. It gives you a public HTTPS URL for Claude, autoscaling, logs, environment variables, and Secret Manager integration without running your own VM.

## Prerequisites

- A Google Cloud project with billing enabled
- Google Cloud CLI installed and logged in
- Airtable PAT and base ID

```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com
```

Pick a region:

```bash
set REGION=us-central1
```

PowerShell users can use:

```powershell
$env:REGION = "us-central1"
```

## Store Secrets

Use Secret Manager for credentials instead of plain deploy args.

PowerShell:

```powershell
"pat..." | gcloud secrets create jobsync-airtable-api-key --data-file=-
"app..." | gcloud secrets create jobsync-airtable-base-id --data-file=-
"a-long-random-token" | gcloud secrets create jobsync-remote-bearer-token --data-file=-
```

Bash:

```bash
printf "pat..." | gcloud secrets create jobsync-airtable-api-key --data-file=-
printf "app..." | gcloud secrets create jobsync-airtable-base-id --data-file=-
printf "a-long-random-token" | gcloud secrets create jobsync-remote-bearer-token --data-file=-
```

If a secret already exists, add a new version:

```bash
printf "pat..." | gcloud secrets versions add jobsync-airtable-api-key --data-file=-
```

## Deploy From Source

From the repo root:

PowerShell:

```powershell
gcloud run deploy jobsync-mcp `
  --source . `
  --region $env:REGION `
  --allow-unauthenticated `
  --port 3000 `
  --memory 1Gi `
  --cpu 1 `
  --min-instances 0 `
  --max-instances 3 `
  --env-vars-file gcp.env.example.yaml `
  --set-secrets AIRTABLE_API_KEY=jobsync-airtable-api-key:latest,AIRTABLE_BASE_ID=jobsync-airtable-base-id:latest,JOBSYNC_REMOTE_BEARER_TOKEN=jobsync-remote-bearer-token:latest
```

Bash:

```bash
gcloud run deploy jobsync-mcp \
  --source . \
  --region $REGION \
  --allow-unauthenticated \
  --port 3000 \
  --memory 1Gi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 3 \
  --env-vars-file gcp.env.example.yaml \
  --set-secrets AIRTABLE_API_KEY=jobsync-airtable-api-key:latest,AIRTABLE_BASE_ID=jobsync-airtable-base-id:latest,JOBSYNC_REMOTE_BEARER_TOKEN=jobsync-remote-bearer-token:latest
```

Cloud Run will build the included `Dockerfile` with Cloud Build and deploy the resulting container.

## Verify

Get the service URL:

```bash
gcloud run services describe jobsync-mcp --region $REGION --format "value(status.url)"
```

Health check:

```bash
curl https://YOUR_CLOUD_RUN_URL/healthz
```

Expected response:

```json
{"ok":true,"service":"jobsync-mcp"}
```

MCP endpoint:

```text
https://YOUR_CLOUD_RUN_URL/mcp
```

## Connect Claude

For a private single-tenant deployment, keep `JOBSYNC_REMOTE_BEARER_TOKEN` enabled and use clients that can send an Authorization header, such as Claude API MCP connector requests.

For Claude.ai custom connectors where users click Connect and sign in, the server needs OAuth. Do not expose a shared Airtable token as an open, unauthenticated public connector.

## Useful Operations

View logs:

```bash
gcloud run services logs read jobsync-mcp --region $REGION
```

Update non-secret environment variables:

```bash
gcloud run services update jobsync-mcp \
  --region $REGION \
  --update-env-vars JOBSYNC_LOOKBACK_HOURS=48,JOBSYNC_ENABLE_FAST_PATH=true
```

Deploy a new revision:

```bash
gcloud run deploy jobsync-mcp --source . --region $REGION
```

Remove public unauthenticated access later:

```bash
gcloud run services remove-iam-policy-binding jobsync-mcp \
  --region $REGION \
  --member="allUsers" \
  --role="roles/run.invoker"
```

If Claude.ai custom connectors need to reach the service directly, the service must remain reachable from Anthropic's cloud infrastructure. Use OAuth at the app layer for user auth.
