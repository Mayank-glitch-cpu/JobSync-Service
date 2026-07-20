# JobSync Service — API Documentation

REST API reference for the JobSync pipeline backend.

**Base URL:** `http://localhost:3001`

---

## Table of Contents

- [Health Check](#health-check)
- [Pipeline](#pipeline)
  - [Step 1 — Fetch Jobs](#step-1--fetch-jobs)
  - [Step 2 — Scrape Job Descriptions](#step-2--scrape-job-descriptions)
  - [Step 3 — AI Processing](#step-3--ai-processing)
  - [Step 4 — Airtable Sync](#step-4--airtable-sync)
  - [Pipeline Status](#pipeline-status)
  - [Pipeline Reset](#pipeline-reset)
- [Data](#data)
- [Logs (SSE)](#logs-sse)
- [Job Sources & Rate Limits](#job-sources--rate-limits)
- [Environment Variables](#environment-variables)
- [External Agent API](#external-agent-api)

---

## Health Check

```
GET /api/health
```

**Response:**

```json
{ "status": "ok" }
```

---

## Pipeline

The pipeline runs in 4 sequential steps. Each step is triggered independently via a POST request and runs asynchronously. The response returns immediately with `{ "status": "started" }` while the step processes in the background.

If a step is already running, the endpoint returns `409 Conflict`.

### Step 1 — Fetch Jobs

```
POST /api/pipeline/step1
```

Fetches raw job listings from the selected source.

**Query Parameters:**

| Parameter | Type   | Default | Description                                      |
|-----------|--------|---------|--------------------------------------------------|
| `source`  | string | `csv`   | Job source: `csv`, `github`, `yc`, or `jsearch`  |
| `from`    | number | —       | Start index (1-based, newest first)               |
| `to`      | number | —       | End index (1-based, inclusive)                     |

If `from` and `to` are omitted, defaults to the first `JOB_COUNT` jobs (default 10).

**Examples:**

```bash
# Fetch 10 newest jobs from Google Sheets
curl -X POST "http://localhost:3001/api/pipeline/step1?source=csv"

# Fetch jobs 1–5 from GitHub
curl -X POST "http://localhost:3001/api/pipeline/step1?source=github&from=1&to=5"

# Fetch from Y Combinator API
curl -X POST "http://localhost:3001/api/pipeline/step1?source=yc&from=1&to=10"

# Fetch from JSearch API
curl -X POST "http://localhost:3001/api/pipeline/step1?source=jsearch&from=1&to=10"
```

**Response:**

```json
{ "status": "started", "step": 1, "source": "csv" }
```

**Error (already running):**

```json
{ "error": "Step 1 is already running" }
```

### Step 2 — Scrape Job Descriptions

```
POST /api/pipeline/step2
```

Scrapes full job descriptions from the `applyLink` URLs found in Step 1 output using Cheerio.

**Response:**

```json
{ "status": "started", "step": 2 }
```

### Step 3 — AI Processing

```
POST /api/pipeline/step3
```

Sends scraped job data to Claude AI for enrichment. Extracts structured fields (summary, salary, tags, etc.) and applies tag detection (FAANG+, Quant, Fortune 500, Unicorn, YC, Crypto/Web3, Internship, New Grad, Remote, Startup).

**Response:**

```json
{ "status": "started", "step": 3 }
```

### Step 4 — Airtable Sync

```
POST /api/pipeline/step4
```

Syncs processed jobs to the configured Airtable base. Creates new records in batches of 10.

**Response:**

```json
{ "status": "started", "step": 4 }
```

### Pipeline Status

```
GET /api/pipeline/status
```

Returns the current status of all four steps.

**Response:**

```json
{
  "step1": {
    "status": "completed",
    "lastRun": "2025-01-29T12:00:00.000Z",
    "jobCount": 10
  },
  "step2": {
    "status": "idle",
    "lastRun": null,
    "jobCount": 0
  },
  "step3": {
    "status": "error",
    "lastRun": "2025-01-29T12:05:00.000Z",
    "jobCount": 0,
    "error": "ANTHROPIC_API_KEY not set"
  },
  "step4": {
    "status": "idle",
    "lastRun": null,
    "jobCount": 0
  }
}
```

**Step statuses:** `idle` | `running` | `completed` | `error`

### Pipeline Reset

```
POST /api/pipeline/reset
```

Clears all stored pipeline data and resets all step statuses to `idle`.

**Response:**

```json
{ "status": "reset" }
```

---

## Data

```
GET /api/data/:step
```

Returns the job data produced by a given step.

**Path Parameters:**

| Parameter | Values  | Description                |
|-----------|---------|----------------------------|
| `step`    | `1`–`4` | Pipeline step number       |

**Step → Data mapping:**

| Step | Data key              | Contents                     |
|------|-----------------------|------------------------------|
| 1    | `step1-raw-jobs`      | Raw fetched job listings     |
| 2    | `step2-scraped-jobs`  | Jobs with scraped JDs        |
| 3    | `step3-processed-jobs`| AI-enriched jobs             |
| 4    | `step4-synced-jobs`   | Airtable-synced records      |

**Response:**

```json
{
  "jobs": [ ... ]
}
```

If no data exists yet:

```json
{
  "jobs": [],
  "message": "No data yet. Run this step first."
}
```

---

## Logs (SSE)

```
GET /api/logs/stream
```

Server-Sent Events endpoint for real-time pipeline logs. On connect, all buffered log history is replayed.

**Event format:**

```
data: {"timestamp":"...","level":"info","step":"fetch","message":"...","data":null}
```

**Log levels:** `info` | `warn` | `error` | `debug`

**Log steps:** `fetch` | `scrape` | `ai` | `sync` | `system`

---

## Job Sources & Rate Limits

### 1. Google Sheets CSV (`csv`)

Fetches jobs from a public Google Sheets document exported as CSV.

| Property        | Value                        |
|-----------------|------------------------------|
| Endpoint        | Google Sheets CSV export URL |
| Authentication  | None (public sheet)          |
| Rate Limits     | **None**                     |

### 2. GitHub (`github`)

Fetches new-grad job postings from [SimplifyJobs/New-Grad-Positions](https://github.com/SimplifyJobs/New-Grad-Positions) by parsing the README HTML tables. Filters to jobs with age `0d` (posted today).

| Property        | Value                                                 |
|-----------------|-------------------------------------------------------|
| Endpoint        | `raw.githubusercontent.com` (raw README fetch)        |
| Authentication  | None                                                  |
| Rate Limits     | **60 requests/hour** (unauthenticated GitHub API)     |

### 3. Y Combinator (`yc`)

Fetches Y Combinator startup jobs from a RapidAPI endpoint.

| Property        | Value                                                              |
|-----------------|--------------------------------------------------------------------|
| Endpoint        | `free-y-combinator-jobs-api.p.rapidapi.com/active-jb-7d`          |
| Authentication  | RapidAPI key (`x-rapidapi-key` header)                             |
| Rate Limits     | Per your RapidAPI subscription plan (shared `RAPIDAPI_KEY`)        |

### 4. JSearch (`jsearch`)

Fetches job listings from the JSearch API on RapidAPI. Supports configurable search queries and pagination.

| Property           | Value                                        |
|--------------------|----------------------------------------------|
| Endpoint           | `jsearch.p.rapidapi.com/search`              |
| Authentication     | RapidAPI key (`x-rapidapi-key` header)       |
| **Rate Limits**    |                                              |
| — Requests/month   | **200**                                      |
| — Requests/hour    | **1,000**                                    |
| — Bandwidth/month  | **10,240 MB**                                |
| Date filter        | `date_posted=today` (only current day)       |
| Pages per request  | Configurable via `JSEARCH_NUM_PAGES` env var |

---

## Environment Variables

| Variable               | Required | Description                                  | Default                              |
|------------------------|----------|----------------------------------------------|--------------------------------------|
| `GOOGLE_SHEETS_CSV_URL`| No       | CSV export URL for the Google Sheet          | Built-in default URL                 |
| `ANTHROPIC_API_KEY`    | Yes*     | Claude API key (for Step 3)                  | —                                    |
| `CLAUDE_MODEL`         | No       | Claude model ID                              | `claude-haiku-4-5-20251201`          |
| `AIRTABLE_API_KEY`     | Yes*     | Airtable personal access token (for Step 4)  | —                                    |
| `AIRTABLE_BASE_ID`     | Yes*     | Airtable base ID                             | —                                    |
| `AIRTABLE_TABLE_NAME`  | No       | Airtable table name                          | `Jobs`                               |
| `RAPIDAPI_KEY`         | Yes*     | RapidAPI key (for YC and JSearch sources)    | —                                    |
| `JSEARCH_QUERY`        | No       | Search query for JSearch API                 | `software developer jobs in USA`     |
| `JSEARCH_NUM_PAGES`    | No       | Number of pages to fetch from JSearch        | `1`                                  |
| `JOB_COUNT`            | No       | Default number of jobs to fetch              | `10`                                 |
| `PORT`                 | No       | Backend server port                          | `3001`                               |

*Required only when using the corresponding step/source.

---

## External Agent API

> **Different service.** The endpoints above belong to the legacy pipeline
> backend (port 3001). The **External Agent API** is a separate machine-to-machine
> surface hosted by the **MCP server** (`mcp-server`, default port 3000), under the
> `/api/external/*` prefix and gated by the `JOBSYNC_REMOTE_BEARER_TOKEN` service
> bearer token.

It lets other apps drive JobSync without a browser (so Firebase login doesn't
apply), in two tiers:

| Endpoint | Style | Intelligence | Persistence |
|----------|-------|--------------|-------------|
| `POST /api/external/search` (+ `GET /api/external/search/:runId`) | Async, poll for result | LLM-vetted agentic search | Writes to a user's pipeline |
| `POST /api/external/jobs/breadth` | Synchronous | Non-LLM keyword/location filters | None — returns candidates only |

See **[external-agent-api.md](./external-agent-api.md)** for full request/response
shapes, error codes, and caveats.
