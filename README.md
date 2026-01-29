# JobsList - AI-Powered Job Aggregation Service

A microservices-based job aggregation system that collects job postings from multiple sources, uses AI (Claude) to extract and standardize fields, and syncs to Airtable.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     DATA SOURCES                                │
├─────────────────────────────────────────────────────────────────┤
│  GitHub Repos        Job Boards           Startup Sites         │
│  - speedyapply/*     - LinkedIn           - TopStartups.io      │
│  - vanshb03/*        - Indeed             - FAANG.watch         │
│                      - Glassdoor          - Wellfound           │
└──────────┬───────────────────┬────────────────────┬─────────────┘
           │                   │                    │
           ▼                   ▼                    ▼
┌──────────────────┐  ┌─────────────────────────────────────┐
│ GitHub Jobs Svc  │  │     Scraping Service (Python)       │
│   (Node.js)      │  │  - JobSpy (LinkedIn/Indeed/etc)     │
│   */15 min       │  │  - Playwright for JS-heavy sites    │
└────────┬─────────┘  └──────────────────┬──────────────────┘
         │                               │
         └───────────────┬───────────────┘
                         ▼
              ┌─────────────────────┐
              │   Redis (BullMQ)    │
              │   Job Queues        │
              └──────────┬──────────┘
                         ▼
              ┌─────────────────────┐
              │   API Service       │
              │   (Node.js/TS)      │
              │                     │
              │  - Deduplication    │
              │  - AI Processing    │
              │  - Airtable Sync    │
              └──────────┬──────────┘
                         │
         ┌───────────────┼───────────────┐
         ▼               ▼               ▼
    PostgreSQL      Claude API       Airtable
```

## Quick Start

### Prerequisites

- Node.js 20+
- pnpm 9+
- Docker and Docker Compose
- Airtable account
- Anthropic API key (for Claude)

### 1. Clone and Install

```bash
cd JobsList
pnpm install
```

### 2. Set Up Environment

```bash
cp .env.example .env
# Edit .env with your API keys
```

Required environment variables:
- `ANTHROPIC_API_KEY` - Your Claude API key
- `AIRTABLE_API_KEY` - Airtable Personal Access Token
- `AIRTABLE_BASE_ID` - Your Airtable Base ID
- `GITHUB_TOKEN` - (Optional) GitHub token for higher rate limits

### 3. Start Services

```bash
# Start PostgreSQL and Redis
pnpm docker:up

# In separate terminals:
pnpm --filter @jobslist/api-service dev
pnpm --filter @jobslist/github-jobs-service dev
```

### 4. Set Up Airtable

Follow the [Airtable Schema Guide](docs/airtable-schema.md) to create your base.

## Project Structure

```
JobsList/
├── packages/
│   ├── shared/                    # Shared types & utilities
│   ├── api-service/               # Central API & orchestration
│   ├── github-jobs-service/       # GitHub markdown parser
│   └── scraping-service/          # Python scrapers
├── scripts/
│   └── init-db.sql               # Database initialization
├── docs/
│   └── airtable-schema.md        # Airtable setup guide
└── docker-compose.yml
```

## Services

### API Service (Port 3000)

Central orchestration service handling:
- Job CRUD operations
- Deduplication (fingerprint + fuzzy matching)
- AI field extraction with Claude
- Airtable synchronization

**Endpoints:**
- `GET /api/v1/jobs` - List jobs with filters
- `POST /api/v1/jobs` - Create job
- `POST /api/v1/jobs/bulk` - Bulk create jobs
- `POST /api/v1/sync/ai` - Trigger AI processing
- `POST /api/v1/sync/airtable` - Trigger Airtable sync
- `GET /api/v1/sync/status` - Get sync status

### GitHub Jobs Service (Port 3001)

Parses job postings from GitHub markdown tables:
- speedyapply/2026-AI-College-Jobs
- speedyapply/2026-SWE-College-Jobs
- vanshb03/New-Grad-2026

Runs every 15 minutes automatically.

**Endpoints:**
- `POST /sync` - Manual sync trigger
- `GET /repos` - List configured repos

### Scraping Service (Port 8000)

Python-based scraping for job boards:
- LinkedIn, Indeed, Glassdoor via JobSpy
- TopStartups.io
- FAANG.watch (Playwright)
- Wellfound (stealth mode)

**Endpoints:**
- `POST /scrape` - Trigger scraping job
- `GET /sources` - List available sources

## Airtable Fields

| Field | Type | Description |
|-------|------|-------------|
| Position Title | Text | Job title |
| Date | Date | Posting date |
| Apply Link | URL | Application link |
| Work Model | Select | Onsite/Remote/Hybrid |
| Location | Text | Job location |
| Company | Text | Company name |
| Tags | Multi-select | FAANG+, Quant, etc. |
| Industry | Select | 21 industry categories |
| Salary | Text | Salary information |
| Job Description | Long text | Full JD |
| Qualifications | Long text | Requirements |
| H1B Sponsored | Checkbox | Visa sponsorship |
| Is New Grad | Checkbox | Entry-level position |
| Is Internship | Checkbox | Internship position |

## AI Processing

Jobs are processed with Claude (Haiku model) to extract:
- Work model (from location/description)
- Industry classification (21 categories)
- H1B sponsorship status
- Qualifications summary
- Salary normalization

## Deduplication

Two-layer deduplication:
1. **Exact match**: SHA256 fingerprint of (company + title + URL)
2. **Fuzzy match**: PostgreSQL pg_trgm similarity on normalized company/title

## Scheduling

| Source | Frequency |
|--------|-----------|
| GitHub Repos | Every 15 min |
| TopStartups.io | Every 2 hours |
| JobSpy (LinkedIn/Indeed) | Every 6 hours |
| FAANG.watch | Twice daily |
| Wellfound | Once daily |
| Airtable Sync | Every 2 min |
| AI Processing | Every 5 min |

## Development

```bash
# Build all packages
pnpm build

# Run tests
pnpm test

# Type check
pnpm --filter @jobslist/shared build
```

## Docker Deployment

```bash
# Build and start all services
docker-compose up --build

# View logs
docker-compose logs -f api-service
```

## License

MIT
