# JobsList API Documentation

Complete API reference for all JobsList microservices.

## Table of Contents

- [API Service (Port 3000)](#api-service-port-3000)
  - [Health Endpoints](#health-endpoints)
  - [Jobs Endpoints](#jobs-endpoints)
  - [Sync Endpoints](#sync-endpoints)
  - [Data Sources Endpoints](#data-sources-endpoints)
- [GitHub Jobs Service (Port 3001)](#github-jobs-service-port-3001)
  - [Health & Info](#health--info)
  - [Sync Endpoints](#sync-endpoints-1)
  - [Testing Endpoints](#testing-endpoints)
- [Data Types & Enums](#data-types--enums)
- [Error Handling](#error-handling)

---

## API Service (Port 3000)

Base URL: `http://localhost:3000/api/v1`

### Health Endpoints

#### Health Check
```http
GET /api/v1/health
```

**Response (200 OK)**
```json
{
  "status": "healthy",
  "timestamp": "2026-01-28T12:00:00.000Z",
  "service": "api-service",
  "version": "1.0.0"
}
```

#### Readiness Check
```http
GET /api/v1/ready
```

**Response (200 OK)**
```json
{
  "ready": true,
  "timestamp": "2026-01-28T12:00:00.000Z"
}
```

---

### Jobs Endpoints

#### List Jobs
```http
GET /api/v1/jobs
```

Retrieve jobs with pagination and filtering.

**Query Parameters**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | number | 1 | Page number (min: 1) |
| `limit` | number | 50 | Items per page (min: 1, max: 100) |
| `source` | string | - | Filter by job source (see [Job Sources](#job-sources)) |
| `industry` | string | - | Filter by industry (see [Industries](#industries)) |
| `workModel` | string | - | Filter by work model: `Onsite`, `Remote`, `Hybrid` |
| `company` | string | - | Filter by company name |
| `isNewGrad` | boolean | - | Filter new grad positions |
| `isInternship` | boolean | - | Filter internship positions |
| `h1bSponsored` | boolean | - | Filter H1B sponsored positions |
| `aiProcessed` | boolean | - | Filter by AI processing status |
| `syncedToAirtable` | boolean | - | Filter by Airtable sync status |
| `search` | string | - | Full-text search |

**Example Request**
```bash
curl "http://localhost:3000/api/v1/jobs?page=1&limit=10&source=github_speedyapply_ai&isNewGrad=true"
```

**Response (200 OK)**
```json
{
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "positionTitle": "Software Engineer",
      "company": "Google",
      "location": "Mountain View, CA",
      "workModel": "Hybrid",
      "salary": "$150,000 - $200,000",
      "applyLink": "https://careers.google.com/jobs/123",
      "datePosted": "2026-01-25",
      "industry": "Software Engineering",
      "tags": ["FAANG+"],
      "isNewGrad": true,
      "isInternship": false,
      "h1bSponsored": true,
      "jobDescription": "Join our team...",
      "qualifications": "BS in Computer Science...",
      "source": "github_speedyapply_swe",
      "sourceUrl": "https://raw.githubusercontent.com/...",
      "aiProcessed": true,
      "aiConfidence": 0.95,
      "aiProcessedAt": "2026-01-26T10:00:00.000Z",
      "syncedToAirtable": true,
      "airtableRecordId": "rec123abc",
      "lastSyncedAt": "2026-01-26T10:05:00.000Z",
      "fingerprint": "sha256hash...",
      "createdAt": "2026-01-25T08:00:00.000Z",
      "updatedAt": "2026-01-26T10:05:00.000Z"
    }
  ],
  "total": 150,
  "page": 1,
  "limit": 10,
  "totalPages": 15
}
```

---

#### Get Single Job
```http
GET /api/v1/jobs/:id
```

**Path Parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | UUID | Job ID |

**Example Request**
```bash
curl http://localhost:3000/api/v1/jobs/550e8400-e29b-41d4-a716-446655440000
```

**Response (200 OK)**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "positionTitle": "Software Engineer",
  "company": "Google",
  ...
}
```

**Response (404 Not Found)**
```json
{
  "error": "Job not found"
}
```

---

#### Create Job
```http
POST /api/v1/jobs
```

Create a new job entry with automatic deduplication check.

**Request Body**
```json
{
  "positionTitle": "Software Engineer",
  "company": "Acme Inc",
  "applyLink": "https://acme.com/careers/123",
  "source": "manual_test",
  "location": "San Francisco, CA",
  "workModel": "Remote",
  "salary": "$120,000 - $150,000",
  "datePosted": "2026-01-28",
  "industry": "Software Engineering",
  "tags": ["Unicorn"],
  "isNewGrad": true,
  "isInternship": false,
  "h1bSponsored": true,
  "jobDescription": "We are looking for...",
  "qualifications": "3+ years experience..."
}
```

**Required Fields**
| Field | Type | Constraints |
|-------|------|-------------|
| `positionTitle` | string | Min 1 character |
| `company` | string | Min 1 character |
| `applyLink` | string | Valid URL |
| `source` | string | Valid [Job Source](#job-sources) |

**Optional Fields**
| Field | Type | Description |
|-------|------|-------------|
| `location` | string | Job location |
| `workModel` | string | `Onsite`, `Remote`, or `Hybrid` |
| `salary` | string | Salary information |
| `datePosted` | string | ISO date format |
| `industry` | string | Industry category |
| `tags` | string[] | Company tags |
| `isNewGrad` | boolean | New grad position |
| `isInternship` | boolean | Internship position |
| `h1bSponsored` | boolean | H1B sponsorship available |
| `jobDescription` | string | Full job description |
| `qualifications` | string | Required qualifications |
| `sourceUrl` | string | Original source URL |
| `rawData` | object | Raw scraped data |

**Response (201 Created)**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "positionTitle": "Software Engineer",
  ...
}
```

**Response (409 Conflict)** - Duplicate detected
```json
{
  "error": "Duplicate job",
  "existingJobId": "550e8400-e29b-41d4-a716-446655440000",
  "matchType": "fingerprint"
}
```

---

#### Bulk Create Jobs
```http
POST /api/v1/jobs/bulk
```

Create multiple jobs at once with batch deduplication.

**Request Body**
```json
[
  {
    "positionTitle": "Software Engineer",
    "company": "Company A",
    "applyLink": "https://example.com/job1",
    "source": "manual_test"
  },
  {
    "positionTitle": "Data Scientist",
    "company": "Company B",
    "applyLink": "https://example.com/job2",
    "source": "manual_test"
  }
]
```

**Response (200 OK)**
```json
{
  "created": 2,
  "duplicates": 0,
  "errors": []
}
```

---

#### Update Job
```http
PATCH /api/v1/jobs/:id
```

Partially update a job. All fields are optional.

**Request Body**
```json
{
  "workModel": "Remote",
  "salary": "$140,000 - $160,000"
}
```

**Response (200 OK)**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "positionTitle": "Software Engineer",
  "workModel": "Remote",
  "salary": "$140,000 - $160,000",
  ...
}
```

---

#### Delete Job
```http
DELETE /api/v1/jobs/:id
```

**Response (200 OK)**
```json
{
  "success": true,
  "deleted": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    ...
  }
}
```

---

#### Queue Job for AI Processing
```http
POST /api/v1/jobs/:id/process
```

Queue a specific job for AI field extraction using Claude.

**Response (200 OK)**
```json
{
  "success": true,
  "message": "Job queued for AI processing"
}
```

---

#### Queue Job for Airtable Sync
```http
POST /api/v1/jobs/:id/sync
```

Queue a specific job for Airtable synchronization.

**Response (200 OK)**
```json
{
  "success": true,
  "message": "Job queued for Airtable sync"
}
```

---

### Sync Endpoints

#### Get Sync Status
```http
GET /api/v1/sync/status
```

Get overall sync status and statistics.

**Response (200 OK)**
```json
{
  "sources": [
    {
      "name": "GitHub SpeedyApply AI",
      "type": "github_speedyapply_ai",
      "enabled": true,
      "lastRun": "2026-01-28T10:00:00.000Z",
      "lastStatus": "success",
      "lastJobsFound": 150
    }
  ],
  "stats": {
    "total": 1500,
    "aiProcessed": 1450,
    "syncedToAirtable": 1400,
    "pendingAi": 50,
    "pendingSync": 50
  }
}
```

---

#### Get Sync History
```http
GET /api/v1/sync/history
```

**Query Parameters**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | number | 1 | Page number |
| `limit` | number | 50 | Items per page |

**Response (200 OK)**
```json
{
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "sourceId": "source-uuid",
      "startedAt": "2026-01-28T10:00:00.000Z",
      "completedAt": "2026-01-28T10:05:00.000Z",
      "status": "completed",
      "jobsFound": 150,
      "jobsNew": 25,
      "jobsUpdated": 10,
      "jobsDuplicates": 115,
      "errorMessage": null,
      "metadata": {}
    }
  ],
  "page": 1,
  "limit": 50
}
```

---

#### Trigger AI Processing
```http
POST /api/v1/sync/ai
```

Queue all unprocessed jobs for AI field extraction.

**Query Parameters**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | 100 | Maximum jobs to process |

**Example Request**
```bash
curl -X POST "http://localhost:3000/api/v1/sync/ai?limit=10"
```

**Response (200 OK)**
```json
{
  "success": true,
  "queued": 10,
  "message": "Queued 10 jobs for AI processing"
}
```

---

#### Trigger Airtable Sync
```http
POST /api/v1/sync/airtable
```

Queue AI-processed jobs for Airtable synchronization.

**Query Parameters**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | 100 | Maximum jobs to sync |

**Example Request**
```bash
curl -X POST "http://localhost:3000/api/v1/sync/airtable?limit=10"
```

**Response (200 OK)**
```json
{
  "success": true,
  "queued": 10,
  "message": "Queued 10 jobs for Airtable sync"
}
```

---

#### Reconciliation Report
```http
POST /api/v1/sync/reconcile
```

Check for unsynced and unprocessed jobs.

**Response (200 OK)**
```json
{
  "success": true,
  "stats": {
    "totalUnsyncedToAirtable": 50,
    "totalUnprocessedByAI": 25
  },
  "message": "Use /sync/ai and /sync/airtable to process pending jobs"
}
```

---

### Data Sources Endpoints

#### List Data Sources
```http
GET /api/v1/sources
```

**Response (200 OK)**
```json
[
  {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "GitHub SpeedyApply AI",
    "sourceType": "github_speedyapply_ai",
    "config": {
      "repo": "speedyapply/2026-AI-College-Jobs",
      "files": ["README.md", "NEW_GRAD_USA.md"]
    },
    "scheduleCron": "*/15 * * * *",
    "enabled": true,
    "lastRunAt": "2026-01-28T10:00:00.000Z",
    "lastRunStatus": "success",
    "lastRunJobsFound": 150,
    "createdAt": "2026-01-01T00:00:00.000Z",
    "updatedAt": "2026-01-28T10:00:00.000Z"
  }
]
```

---

#### Update Data Source
```http
PATCH /api/v1/sources/:id
```

**Request Body**
```json
{
  "enabled": false,
  "scheduleCron": "0 */2 * * *"
}
```

**Response (200 OK)**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "GitHub SpeedyApply AI",
  "enabled": false,
  "scheduleCron": "0 */2 * * *",
  ...
}
```

---

## GitHub Jobs Service (Port 3001)

Base URL: `http://localhost:3001`

### Health & Info

#### Health Check
```http
GET /health
```

**Response (200 OK)**
```json
{
  "status": "healthy",
  "timestamp": "2026-01-28T12:00:00.000Z",
  "service": "github-jobs-service"
}
```

---

#### List Configured Repositories
```http
GET /repos
```

**Response (200 OK)**
```json
[
  {
    "key": "speedyapply_ai",
    "repo": "speedyapply/2026-AI-College-Jobs",
    "files": ["README.md", "NEW_GRAD_USA.md", "INTERN_USA.md"],
    "enabled": true
  },
  {
    "key": "speedyapply_swe",
    "repo": "speedyapply/2026-SWE-College-Jobs",
    "files": ["README.md", "NEW_GRAD_USA.md", "INTERN_USA.md"],
    "enabled": true
  },
  {
    "key": "vanshb03",
    "repo": "vanshb03/New-Grad-2026",
    "files": ["README.md"],
    "enabled": true
  }
]
```

---

### Sync Endpoints

#### Sync All Repositories
```http
POST /sync
```

Fetch and parse jobs from all configured GitHub repositories.

**Query Parameters**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `scrapeJD` | boolean | false | Scrape full job descriptions |

**Example Request**
```bash
curl -X POST "http://localhost:3001/sync?scrapeJD=false"
```

**Response (200 OK)**
```json
{
  "success": true,
  "results": {
    "speedyapply_ai": {
      "jobsFound": 150,
      "totalParsed": 150,
      "errors": [],
      "scrapeJD": false
    },
    "speedyapply_swe": {
      "jobsFound": 200,
      "totalParsed": 200,
      "errors": [],
      "scrapeJD": false
    },
    "vanshb03": {
      "jobsFound": 100,
      "totalParsed": 100,
      "errors": [],
      "scrapeJD": false
    }
  }
}
```

---

#### Sync Specific Repository
```http
POST /sync/:repoKey
```

**Path Parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `repoKey` | string | Repository key: `speedyapply_ai`, `speedyapply_swe`, or `vanshb03` |

**Query Parameters**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `scrapeJD` | boolean | false | Scrape full job descriptions |

**Example Request**
```bash
curl -X POST "http://localhost:3001/sync/speedyapply_ai"
```

**Response (200 OK)**
```json
{
  "success": true,
  "result": {
    "jobsFound": 150,
    "totalParsed": 150,
    "errors": [],
    "scrapeJD": false
  }
}
```

**Response (404 Not Found)**
```json
{
  "error": "Repository not found"
}
```

---

### Testing Endpoints

#### Test Sync (Limited Jobs)
```http
POST /test-sync
```

Run a limited sync for testing purposes.

**Query Parameters**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | 5 | Maximum jobs to process |
| `repoKey` | string | - | Specific repo to test (optional) |
| `scrapeJD` | boolean | true | Scrape job descriptions (default: true for testing) |

**Example Request**
```bash
curl -X POST "http://localhost:3001/test-sync?limit=5&scrapeJD=true"
```

**Response (200 OK)**
```json
{
  "success": true,
  "testMode": true,
  "limit": 5,
  "result": {
    "jobsFound": 5,
    "totalParsed": 5,
    "errors": [],
    "scrapeJD": true
  }
}
```

---

#### Scrape Job Description
```http
POST /scrape-jd
```

Test scraping a job description from a single URL.

**Request Body**
```json
{
  "url": "https://boards.greenhouse.io/company/jobs/123"
}
```

**Response (200 OK)**
```json
{
  "success": true,
  "result": {
    "description": "We are looking for a talented engineer...",
    "qualifications": "- 3+ years of experience\n- BS in Computer Science",
    "responsibilities": "- Design and implement features\n- Code review",
    "benefits": "- Health insurance\n- 401k matching",
    "rawText": "Full page text content...",
    "scrapedAt": "2026-01-28T12:00:00.000Z",
    "error": null
  }
}
```

**Response (400 Bad Request)**
```json
{
  "error": "URL is required"
}
```

---

## Data Types & Enums

### Job Sources
```
github_speedyapply_ai    - SpeedyApply AI College Jobs repo
github_speedyapply_swe   - SpeedyApply SWE College Jobs repo
github_vanshb03         - Vanshb03 New Grad 2026 repo
linkedin                - LinkedIn job board
indeed                  - Indeed job board
glassdoor               - Glassdoor job board
google_jobs             - Google Jobs
ziprecruiter            - ZipRecruiter
topstartups             - TopStartups.io
faang_watch             - FAANG.watch
wellfound               - Wellfound (AngelList)
google_sheets           - Manual Google Sheets import
manual_test             - Manual test entries
```

### Industries
```
Software Engineering     Data Analyst           Marketing
ML/AI                   Business Analyst       Product Management
Creatives/Design        Accounting/Finance     Consulting
Engineering             HR                     Arts/Entertainment
Management/Executive    Customer Service       Legal/Compliance
Sales                   Public Sector          Education
Cybersecurity           Project Manager        Healthcare
Supply Chain
```

### Work Models
```
Onsite   - In-office work
Remote   - Fully remote
Hybrid   - Mix of remote and in-office
```

### Company Tags
```
FAANG+        - Meta, Google, Amazon, Apple, Netflix, Microsoft, Nvidia, etc.
Quant         - Citadel, Two Sigma, Jane Street, DE Shaw, etc.
Unicorn       - $1B+ valued startups
Fortune 500   - Major corporations
YC            - Y Combinator backed
Crypto/Web3   - Coinbase, Binance, OpenSea, etc.
```

### Sync Status
```
running    - Sync operation in progress
completed  - Sync completed successfully
failed     - Sync failed with errors
```

---

## Error Handling

### Standard Error Response
```json
{
  "error": "Error message description"
}
```

### Duplicate Error Response
```json
{
  "error": "Duplicate job",
  "existingJobId": "uuid",
  "matchType": "fingerprint | fuzzy"
}
```

### HTTP Status Codes

| Code | Description |
|------|-------------|
| 200 | Success |
| 201 | Created |
| 400 | Bad Request - Invalid input |
| 404 | Not Found - Resource doesn't exist |
| 409 | Conflict - Duplicate detected |
| 500 | Internal Server Error |

---

## Rate Limits

| Service | Limit | Description |
|---------|-------|-------------|
| AI Processing | 50 jobs/min | Claude API rate limit |
| Airtable Sync | 5 req/sec | Airtable API rate limit |
| GitHub API | 60 req/hr (unauthenticated) | Use `GITHUB_TOKEN` for higher limits |

---

## Webhooks & Background Processing

Jobs are automatically queued for processing:

1. **On job creation** → Queued for AI processing
2. **After AI processing** → Queued for Airtable sync

Background workers handle:
- `jobs` queue - Job ingestion from scrapers
- `ai-process` queue - Claude AI field extraction
- `airtable-sync` queue - Airtable synchronization

---

## Quick Reference

### Common Operations

**Fetch recent new grad jobs:**
```bash
curl "http://localhost:3000/api/v1/jobs?isNewGrad=true&limit=20"
```

**Sync GitHub and process with AI:**
```bash
# 1. Sync GitHub repos
curl -X POST http://localhost:3001/sync

# 2. Process with AI
curl -X POST http://localhost:3000/api/v1/sync/ai

# 3. Sync to Airtable
curl -X POST http://localhost:3000/api/v1/sync/airtable
```

**Test with 5 jobs:**
```bash
curl -X POST "http://localhost:3001/test-sync?limit=5"
```

**Check sync status:**
```bash
curl http://localhost:3000/api/v1/sync/status
```
