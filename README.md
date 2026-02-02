# JobsList - AI-Powered Job Aggregation Pipeline

A job aggregation pipeline that collects postings from multiple sources, scrapes job descriptions, uses Claude AI to extract structured fields, and syncs everything to an Airtable dashboard.

![JobSync Dashboard](jobSyncdash.jpeg)

**[View the Airtable Dashboard](https://airtable.com/appcyGTbc7gA6BS0w/pagQAZFMZ12RLHjmb)**

## How It Works

```
Sources                    Pipeline                         Output
─────────                  ─────────                        ──────
Google Sheets CSV  ─┐
GitHub (Simplify)  ─┤      Step 1: Fetch Raw Jobs
Y Combinator       ─┼───►  Step 2: Scrape Job Descriptions  ───►  Airtable
JSearch API        ─┤      Step 3: AI Processing (Claude)          Dashboard
Ashby Job Boards   ─┘      Step 4: Sync to Airtable
```

### Pipeline Steps

| Step | What it does |
|------|-------------|
| **1. Fetch** | Pulls raw job listings from the selected source |
| **2. Scrape** | Visits each apply link and extracts the full job description |
| **3. AI Process** | Claude extracts work model, industry, H1B status, qualifications, and tags |
| **4. Sync** | Pushes enriched jobs to Airtable in batches |

### Job Sources

| Source | Auth | Description |
|--------|------|-------------|
| **Google Sheets** | None | CSV export from a public Google Sheet |
| **GitHub** | None | Parses SimplifyJobs/New-Grad-Positions README |
| **Y Combinator** | RapidAPI key | YC company job listings |
| **JSearch** | RapidAPI key | Broad job search API (Indeed, LinkedIn, etc.) |
| **Ashby** | None | Scrapes public Ashby job boards (OpenAI, Ramp, Notion, Cursor, etc.) |

## Quick Start

### Prerequisites

- Node.js 20+
- pnpm 9+
- Anthropic API key
- Airtable account + API key

### Setup

```bash
pnpm install

cp .env.example .env
# Edit .env with your API keys
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Claude API key for AI processing |
| `AIRTABLE_API_KEY` | Yes | Airtable personal access token |
| `AIRTABLE_BASE_ID` | Yes | Your Airtable base ID |
| `RAPIDAPI_KEY` | For YC/JSearch | RapidAPI key for YC and JSearch sources |
| `CLAUDE_MODEL` | No | Defaults to `claude-3-5-haiku-20241022` |
| `JOB_COUNT` | No | Default number of jobs to fetch (default: 10) |

### Run Locally

```bash
# Start both backend and frontend in dev mode
pnpm dev
```

- Backend: http://localhost:3001
- Frontend: http://localhost:5173

## Project Structure

```
JobsList/
├── backend/
│   └── src/
│       ├── services/          # Fetchers (CSV, GitHub, YC, JSearch, Ashby)
│       │                      # Scraper, AI processor, Airtable sync
│       ├── routes/            # Pipeline + data API routes
│       ├── constants/         # Industry categories
│       ├── config.ts          # Environment config
│       ├── store.ts           # JSON file persistence
│       └── index.ts           # Fastify server
├── frontend/
│   └── src/
│       ├── components/        # Pipeline UI (StepPanel, StepButton, etc.)
│       └── hooks/             # API hooks
├── render.yaml                # Render deployment config
└── docs/
    └── api.md                 # API documentation
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Health check |
| `/api/pipeline/step1?source=<src>` | POST | Fetch raw jobs |
| `/api/pipeline/step2` | POST | Scrape job descriptions |
| `/api/pipeline/step3` | POST | AI process with Claude |
| `/api/pipeline/step4` | POST | Sync to Airtable |
| `/api/pipeline/status` | GET | Get all step statuses |
| `/api/pipeline/reset` | POST | Clear all data |
| `/api/data/:step` | GET | Get output from step 1-4 |
| `/api/logs/stream` | GET | SSE real-time log stream |

## AI Processing

Claude (Haiku) extracts from each job:
- **Work Model** — Remote / Hybrid / Onsite
- **Industry** — 22 categories (Software Engineering, ML/AI, Finance, etc.)
- **H1B Sponsorship** — explicit mention required
- **Qualifications** — key requirements summary
- **Tags** — auto-detected: FAANG+, Quant, Fortune 500, Unicorn, YC, Crypto/Web3
- **Job Board** — Lever, Ashby, Greenhouse, LinkedIn, Workday

## Deployment (Render)

The app deploys as a single service on Render's free tier:

1. Push to GitHub
2. Go to [dashboard.render.com](https://dashboard.render.com) → **New** → **Blueprint**
3. Connect your repo — Render auto-detects `render.yaml`
4. Set secret env vars: `ANTHROPIC_API_KEY`, `AIRTABLE_API_KEY`, `AIRTABLE_BASE_ID`, `RAPIDAPI_KEY`
5. Deploy

In production, the backend serves the frontend static build, so everything runs from a single URL.

## License

MIT
