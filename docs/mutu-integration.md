# Mutu ↔ JobSync Integration

JobSync acts as the **data-aggregation service** behind Mutu AI (retrieval + recsys).
Mutu owns accounts and UX; JobSync owns parsing, structured storage, and the jobs corpus.

## Data flow

```
Mutu signup ──► POST /api/mutu/users              (demographics: name, country, email,
                                                   socials, work authorization)
Resume ingest ──► POST /api/mutu/users/:id/resume
                    │  Primary: Mutu parses the resume itself (Sonnet 5) and sends
                    │  { "resume": {23-field JSON}, "parserModel": "claude-sonnet-5" }
                    │  — no file transfer, no GPU, no cold start.
                    ├─► normalized against the 23-field schema (zod, null-tolerant)
                    ├─► stored in JobSync relational DB (resumes + resume_skills)
                    └─► normalized JSON echoed back for the preview screen
                    Fallback: { filename, contentBase64 } → optional GPU worker
                    (infra/resume-parser-worker, Qwen3VL) for callers without a parser

Role synthesis ─► POST /api/mutu/roles/synthesize
                    aggregates users + resumes → existing Anthropic agent (lib/agent/llm.ts)
                    → recommended roles for the user base → stored in role_synth_runs
                    → optionally seeds the existing agentic search (/api/external/search)
                      and breadth pull, which populate the jobs table

Retrieval ──────► GET /api/mutu/jobs?skills=...&country=...&role=...
                    Mutu's recsys/retrieval layer reads structured jobs
```

## Relational schema (`~/.jobsync/mutu.db`, node:sqlite, FKs ON)

```
users            user_id PK · email UNIQUE · first_name · last_name · country
                 work_authorization · linkedin · github · google_scholar
                 extra_links JSON · created_at · updated_at

resumes          resume_id PK · user_id FK→users (1:1, latest wins)
                 parsed JSON (full 23-field record) · desired_position
                 min_salary · max_salary · ready_to_relocate
                 parser_model · parsed_at

resume_skills    resume_id FK→resumes · skill_name · level     (queryable skills index)

jobs             job_id PK · url_hash UNIQUE · company · position_title · apply_link
                 location · source · tags JSON · posted_at · created_at

role_synth_runs  run_id PK · created_at · user_count · resume_count
                 roles JSON [{role, rationale, demand_signals}] · model
```

## API surface (`/api/mutu/*`)

All routes require `Authorization: Bearer $JOBSYNC_REMOTE_BEARER_TOKEN` — the same
service token that gates `/api/external/*`.

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/mutu/users` | Upsert demographics by email; returns `userId` |
| GET | `/api/mutu/users/:id` | User + parsed resume |
| POST | `/api/mutu/users/:id/resume` | Primary: `{ resume, parserModel? }` (pre-parsed 23-field JSON from Mutu). Fallback: `{ filename, contentBase64 }` → worker parse. Both store + return the normalized record |
| GET | `/api/mutu/users/:id/resume` | Stored parsed resume |
| POST | `/api/mutu/roles/synthesize` | Aggregate user base → LLM → role recommendations (optionally `{ seedSearch: true, uid }`) |
| GET | `/api/mutu/roles/latest` | Most recent synthesis run |
| POST | `/api/mutu/jobs/ingest` | Bulk-insert jobs (from breadth/search output) into the relational jobs table |
| GET | `/api/mutu/jobs` | Filtered retrieval: `role`, `skills` (csv), `country`, `limit` |

## Resume parsing

**Primary: pre-parsed ingestion.** Mutu already runs Sonnet 5 on uploaded resumes;
it POSTs the resulting JSON to JobSync — **mapped into the 23-field record**, not
its native `ResumeParseResponse` shape. Malformed individual fields are nulled by
the zod normalizer; 422 is returned when the payload isn't an object, or when the
record normalizes to effectively empty (all identity fields null, no skills/
experiences/educations — the signature of an unmapped native payload). This avoids
the GPU worker's 1–2 min cold start entirely.

Item shapes for the nested arrays (all fields null-tolerant):

```
skills[]        { skill_name, level }
experiences[]   { company_name, job, date_from, date_to, description, country_name }
languages[]     { language_name, level }
educations[]    { name, degree, location, programme, date_from, date_to, country_name }
certificates[]  { certificate_name, certificate_programme, issuing_date, expiring_date }
projects[]      { title, summary, used_technologies[], role, industries[] }
```

**Fallback: the GPU worker** (optional — only for callers that can't parse).
The Qwen3VL model is a multi-GB VLM — it runs in a dedicated GPU worker, not in Node.

- **Worker:** `infra/resume-parser-worker/` — FastAPI + transformers, exact inference
  code from the model card. Accepts a PDF or images, converts PDF→PNG pages with
  pypdfium2, returns the 23-field JSON. Containerized; deploys to Cloud Run GPU
  (L4) or an HF Inference Endpoint.
- **Node client:** `src/lib/mutu/parser-client.ts` POSTs the file to
  `RESUME_PARSER_URL`, validates the response against the zod schema in
  `src/lib/mutu/schema.ts` (null-tolerant, coerces malformed fields).
- **Fallback:** if `RESUME_PARSER_URL` is unset, `JOBSYNC_MUTU_PARSER=stub` returns a
  deterministic stub so the whole contract is testable without GPU spend.

## Env

```
JOBSYNC_REMOTE_BEARER_TOKEN=...   # already used by /api/external
RESUME_PARSER_URL=https://<cloud-run-or-hf-endpoint>
RESUME_PARSER_TOKEN=...           # optional bearer for the worker
JOBSYNC_MUTU_PARSER=remote|stub   # default remote when URL set, else stub
ANTHROPIC_API_KEY=...             # role synthesis (existing agent runtime)
```

## Not in this pass

Firestore backing for the relational tables (SQLite first; the adapter seam exists),
Mutu-side webhook callbacks, and embedding-based job↔user matching (the `embeddings.ts`
lib is the natural next step once tables are populated).
