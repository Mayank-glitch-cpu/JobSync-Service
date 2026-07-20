# External Agent API

A machine-to-machine surface (`/api/external/*`) for other applications to drive
JobSync **without a browser**, so the Firebase login used by the dashboard doesn't
apply. Every route is gated by the same service bearer token as the auto-apply
routes: `Authorization: Bearer $JOBSYNC_REMOTE_BEARER_TOKEN`. (When the token env
var is unset the server runs authless, same as the rest of the HTTP surface.)

Implemented in [`mcp-server/src/api/external.ts`](../mcp-server/src/api/external.ts),
dispatched from [`mcp-server/src/http.ts`](../mcp-server/src/http.ts).

There are two tiers — slow-but-smart and fast-but-dumb:

| | `POST /api/external/search` | `POST /api/external/jobs/breadth` |
|---|---|---|
| Style | Async (poll for result) | Synchronous |
| Intelligence | LLM-vetted agentic search | Non-LLM keyword/location filters |
| Persistence | Writes to a user's pipeline | None — returns candidates only |
| Speed | Minutes | Seconds |
| Scope | Requires an explicit `uid` | Anonymous |

---

## `POST /api/external/search` — agentic search (async)

Wraps the same `runSearchAgent` the dashboard uses. The run is scoped to the
`uid` you supply and its results land in **that user's** pipeline. Returns
immediately with a `runId`; poll the GET route for status.

**Request**
```json
{
  "uid": "firebase-user-id",
  "params": {
    "lookbackHours": 48,
    "roles": ["machine learning engineer", "data scientist"],
    "companies": ["stripe", "openai"]
  }
}
```
`params` may also be flattened to the top level. All of `lookbackHours`, `roles`,
and `companies` are optional (the agent falls back to the user's profile roles).

**Response — `202 Accepted`**
```json
{
  "runId": "d1f2…",
  "status": "running",
  "poll": "/api/external/search/d1f2…?uid=firebase-user-id"
}
```

**Errors**
- `400` — `uid` missing.
- `409` — a search is already running for this user (one at a time).
- `503` — search agent not configured (`ANTHROPIC_API_KEY` missing).

### `GET /api/external/search/:runId?uid=<uid>` — poll a run

`uid` is required as a query parameter and must match the run's owner.

**Response — `200 OK`**
```json
{
  "runId": "d1f2…",
  "status": "succeeded",
  "createdAt": "2026-07-10T12:00:00.000Z",
  "finishedAt": "2026-07-10T12:03:12.000Z",
  "result": { "added": 7, "updated": 2 },
  "summary": "Added 7 roles across Stripe and OpenAI…",
  "error": null,
  "progress": ["[12:00:01] Search run started.", "→ profile_read", "…"]
}
```
`status` is one of `queued | running | succeeded | failed`. `404` if no such run
exists for that user.

---

## `POST /api/external/jobs/breadth` — direct ATS pull (synchronous)

Fetches straight from public ATS boards in parallel and applies simple
keyword/location filters. No LLM, no scraping, no persistence — just a fast,
raw candidate list. A dead slug fails on its own without sinking the batch.

**Request**
```json
{
  "sources": {
    "greenhouse": ["stripe", "airbnb"],
    "lever": ["netflix"],
    "ashby": ["openai"],
    "workday": ["https://tenant.wd1.myworkdayjobs.com/en-US/External"]
  },
  "include": ["engineer", "developer", "ml", "data"],
  "exclude": ["senior", "staff", "principal"],
  "usOnly": true,
  "limit": 200
}
```
- `sources` — required. Greenhouse/Lever/Ashby take board **slugs**; Workday takes
  the full board **URL**.
- `include` / `exclude` — optional title keyword lists. Omit to use the built-in
  defaults; pass `include: []` to disable the keyword requirement (and
  `exclude: []` to disable exclusions).
- `usOnly` — optional, defaults `true`; drops likely non-US locations.
- `limit` — optional cap on returned jobs (1–1000, default 200).

**Response — `200 OK`**
```json
{
  "jobs": [
    {
      "id": "gh:stripe:12345",
      "positionTitle": "Software Engineer, ML",
      "company": "Stripe",
      "location": "San Francisco, CA",
      "applyLink": "https://…",
      "datePosted": "2026-07-08T…",
      "salary": null,
      "rawFields": { "source": "greenhouse", "slug": "stripe" }
    }
  ],
  "counts": { "fetched": 510, "matched": 63, "returned": 63 },
  "sources": [
    { "source": "greenhouse", "ref": "stripe", "ok": true, "fetched": 510 },
    { "source": "lever", "ref": "bad-slug", "ok": false, "fetched": 0, "error": "… → 404 Not Found" }
  ]
}
```

**Errors**
- `400` — no usable `sources` provided.

### Caveats
- Workday postings carry no reliable `datePosted` (it's `null`); the human-readable
  `postedOn` is preserved under `rawFields.postedOn`.
- Filtering is keyword-only — it does not read job descriptions or judge fit. Use
  the `/search` tier when you need vetted, ranked results.
