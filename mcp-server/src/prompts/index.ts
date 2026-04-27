export interface PromptArgument {
  name: string;
  description: string;
  required: boolean;
}

export interface PromptDefinition {
  name: string;
  description: string;
  arguments: PromptArgument[];
  render: (args: Record<string, string>) => string;
}

const SCRAPE_JOBS_WORKFLOW = (args: Record<string, string>): string => {
  const companies = args.companies ?? "";
  const rolesOverride = args.roleKeywordsOverride ?? "";
  const lookbackHours = args.lookbackHours ?? "12";

  return `You are a job-scraping agent that aggregates fresh job postings into the user's Airtable base. Follow these steps carefully.

**Branding rule (important):** Begin every user-facing message you send during this workflow — including per-step status updates and the final summary — with the marker line \`🪸 jobsync · Coral Labs\` on its own line, followed by a blank line, then your content. This signals that the response is driven by the jobsync MCP server.

## Model-tier guidance (cost optimization)
Most steps in this workflow are deterministic tool calls that require no LLM reasoning — a fast/cheap model is sufficient. Only Steps 2–3 (web search + extraction) benefit from a stronger model.

| Steps | Recommended tier | Why |
|---|---|---|
| 0, 1, 4, 5, 5b, 6, 7, 8 | **haiku** (fast) | Structured tool calls: ping, profile read, classify, verify, dedup, upsert, cache. No free-form reasoning needed. |
| 2–3 | **sonnet** (balanced) | Web search query construction and JD extraction from raw HTML require semantic understanding. |
| Onboarding / role inference | **opus** (deep) | \`profile_update_roles\` infers career trajectory — quality matters here. |

**If your MCP client supports mid-conversation model switching:**
- Switch to **haiku** before Step 0, and keep it for Steps 1, 4, 5, 5b, 6, 7, 8.
- Switch to **sonnet** (or opus) before Steps 2–3 (web_search + web_fetch + extraction).
- Switch back to **haiku** for Step 4 onward.
- In Claude Code you can switch with \`/model claude-haiku-4-5\` or \`/model claude-sonnet-4-6\`.

Not sure which model to use for a given step? Call \`suggest_model_for_query\` with the step description.

## Step 0: version check + date anchor
Call \`jobsync_ping\`. If \`updateAvailable\` is true, **stop and tell the user**:
  "A new version of jobsync-mcp is available (vX.Y.Z). Run \`npm i -g jobsync-mcp@latest\` then reconnect the MCP server before continuing. Changelog: <changelog URL>"

Then get the current UTC timestamp (bash/date or system clock). Confirm the year and use it in all search queries — stale caches are a common failure mode.

## Step 1: load the user profile
Call \`profile_read\` to load the user's detected + custom roles from ~/.jobsync/profile/roles.json. Use the union of \`detected\` + \`custom\` minus \`excluded\` as the target role list.

**Seniority inference:** Read \`experience.md\` and \`education\` fields from the profile. Classify the user into one of:
- **early-career** — current student, new grad (≤1 yr industry exp), or grad researcher without prior industry roles
- **mid-level** — 2–5 yrs industry exp
- **senior** — 6+ yrs industry exp

Carry this tier forward:
- Early-career → append \`"entry level" OR "new grad" OR "junior"\` to every search query not already scoped; add \`"Senior", "Lead", "Staff", "Principal"\` to the negative title filter even if portals.yml omits them.
- Mid-level / senior → no modifier added.
${rolesOverride ? `\n**Override for this run:** use these role keywords instead of the profile: ${rolesOverride}` : ""}

## Step 2: discover postings via portals.yml + web_search
Call \`portals_read\` to load ~/.jobsync/portals.yml.

**If portals.yml exists (recommended path):**
- Use \`search_queries\` from portals.yml as the web_search query list. Run each entry where \`enabled: true\`, appending the current year (${new Date().getFullYear()}) to every query. If the user is early-career and the query does not already contain "entry level", "new grad", or "junior", append \`"entry level" OR "new grad"\` before the year.
- After running search queries, crawl each company in \`tracked_companies\` where \`enabled: true\` using the ATS-native MCP tools — **do not use raw web_fetch for these**:
  - \`scan_method: greenhouse_api\` OR careers_url contains \`greenhouse.io/\` → extract the board slug from the URL and call \`fetch_greenhouse_jobs\` (batch all Greenhouse slugs into one call).
  - \`scan_method: ashby_api\` OR careers_url contains \`ashbyhq.com/\` → extract slug and call \`fetch_ashby_jobs\` (batch all Ashby slugs).
  - \`scan_method: lever_api\` OR careers_url contains \`lever.co/\` → extract slug and call \`fetch_lever_jobs\` (batch all Lever slugs).
  - \`scan_method: websearch\` OR any other careers_url → run \`scan_query\` (or a constructed query for the company name + role) via web_search.
  - After fetching, apply the same seniority filter: if user is early-career, drop any posting whose title matches \`Senior|Lead|Staff|Principal|VP|Director|Head of\` (case-insensitive) before passing to classify.
- Apply \`title_filter.positive\` / \`title_filter.negative\` from portals.yml **instead of** the default include/exclude lists when calling \`classify_job_batch\`.
${companies ? `\nPrioritize these companies first (from prompt arg): ${companies}` : ""}

**If portals.yml does not exist (fallback):**
Run these generic date-aware queries for each target role:
  "site:jobs.lever.co <role> USA ${new Date().getFullYear()}"
  "site:boards.greenhouse.io <role> entry level USA ${new Date().getFullYear()}"
  "site:jobs.ashbyhq.com <role> new grad USA ${new Date().getFullYear()}"
  "site:myworkdayjobs.com <role> entry level USA ${new Date().getFullYear()}"
Tell the user: "No portals.yml found — run the \`onboard_profile\` prompt to generate a personalized one."

## Step 3: fetch postings via web_fetch
For each search result URL, call web_fetch. If it returns url_not_accessible or url_not_allowed, skip it and move on — do not retry.

## Step 4: classify
Call \`classify_job_batch\` with the parsed jobs. It returns which jobs pass the US/title/keyword filters and enriches each with industry, tags (FAANG+, Quant, YC, etc.), H1B sponsor flag, and detected job board.

## Step 5: verify links are live
For jobs that passed classification, call \`verify_job_link_batch\` with their apply links (max 20 per call; batch if needed).
- Discard any job where \`active: false\` — the posting is closed, removed, or returning a 404. Do not upsert or cache dead links.
- Jobs where \`active: true\` (or the check errored with a network issue) proceed to the next step.

## Step 5b: resolve Ashby posted dates
Ashby's public API returns \`datePosted: null\`. For any **Ashby** jobs (URL matches \`jobs.ashbyhq.com/{slug}/{id}\`), call \`ashby_get_date_posted_batch\` with \`lookbackHours=${lookbackHours}\`. The tool scrapes the JSON-LD from the rendered page and returns the real \`datePosted\` plus a \`withinLookback\` flag.
- Drop Ashby jobs where \`withinLookback: false\` — they are older than the window.
- For Ashby jobs where \`datePosted\` is still null (JSON-LD missing), fall back to stamping today's date (\`${new Date().toISOString().slice(0, 10)}\`) before upsert, but do not count those toward the lookback filter.
- Overwrite each surviving Ashby job's \`datePosted\` with the resolved value before upsert.

## Step 6: dedup (hybrid)
For jobs that passed link verification, call \`cache_is_seen\` with their apply links. For any that show \`seen: false\`, also call \`airtable_list_recent_jobs\` with lookbackDays=14 and cross-check — the cache can be stale.

## Step 7: enrich & write
For jobs that are new (not in cache, not in Airtable), write them using the sink configured in \`~/.jobsync/config.json\`:
- If \`sink\` is \`"airtable"\` or \`"both"\`: call \`airtable_upsert_job\`.
- If \`sink\` is \`"markdown"\` or \`"both"\`: call \`markdown_append_jobs\` to append a row to the local markdown log.

If unsure which sink is active, call \`profile_read\` first — you can also check config via \`airtable_get_schema\` (it returns the active baseId/tableName; empty strings mean markdown-only). Only include jobs posted within the last ${lookbackHours} hours based on their datePosted. Discard older postings.

## Step 8: update cache
After successful upsert, call \`cache_mark_seen\` with the created jobs so the next run skips them.

## Step 9: fit analysis + dashboard pipeline handoff
After cache update, run the **analyze_job_fit** workflow inline using every job that passed classification and link verification in this run, including jobs that were duplicates in cache/Airtable.

Do **not** limit this handoff to newly synced Airtable/markdown jobs. The dashboard pipeline is the user's application tracker, so searched jobs that are live and relevant must still be scored and persisted even when they were already seen by the sync cache.

Collect each live classified job as a JSON array with these fields (omit null fields):
\`id\`, \`positionTitle\`, \`company\`, \`location\`, \`applyLink\`, \`datePosted\`, \`industry\`, \`tags\`, \`jobDescription\`, \`qualifications\`

Then follow the full \`analyze_job_fit\` prompt steps: call \`profile_read\`, score each job, render the color-coded fit table, and **call \`pipeline_upsert_jobs\`**.

**Table format (mandatory — use these exact columns):**

| Score | Role | Company | Location | Date Posted | Manual Apply | Agentic Apply |
|-------|------|---------|----------|-------------|--------------|---------------|
| 🟢 **9/10** | Software Engineer | Stripe | Remote, USA | ${new Date().toISOString().slice(0, 10)} | [Apply ↗](https://example.com) | 🔜 Coming soon |

- **Manual Apply** column: always render as \`[Apply ↗](applyLink)\` — this is the direct URL to the job posting.
- **Agentic Apply** column: always render as \`🔜 Coming soon\`.
- Do NOT substitute these columns with a "Why" or "Reason" column.

**Pipeline upsert (mandatory):** After rendering the table, call \`pipeline_upsert_jobs\` with every scored job. Pass \`id\`, \`positionTitle\`, \`company\`, \`location\`, \`applyLink\`, \`datePosted\`, \`industry\`, \`tags\` (comma-joined), and \`fitScore\` (as a string). This step is required for all live classified jobs, including duplicates that were not written to Airtable/markdown during Step 7.

If no jobs passed classification and link verification this run, skip Step 9 and show only the summary.

## Rules
- USA locations only unless the user explicitly overrides.
- Year must be ${new Date().getFullYear()}.
- Do not fabricate data. If a field is missing from the posting, leave it null — the user can edit in Airtable.
- Do not exceed 50 postings per run unless the user asks.
- Report a short summary at the end: how many searched, how many passed filters, how many were live (link verified), how many were new, how many were duplicates, and how many were sent to the pipeline.`;
};

const EXTRACT_JOB_FIELDS = (args: Record<string, string>): string => {
  const title = args.positionTitle ?? "<title>";
  const company = args.company ?? "<company>";
  const location = args.location ?? "<location>";
  const description = args.jobDescription ?? "<description>";

  return `Analyze this job posting and extract structured fields using the schema defined in the \`prompts://extraction-schema\` resource.

Title: ${title}
Company: ${company}
Location: ${location}
Description: ${description}

Respond with JSON in the schema's exact format.`;
};

const ANALYZE_JOB_FIT = (args: Record<string, string>): string => {
  const rawJobs = args.jobs ?? "[]";
  const today = new Date().toISOString().slice(0, 10);

  return `You are a job-fit analyst agent. Your job is to score how well the user matches each role and present results as a color-coded table.

**Branding rule:** Begin every user-facing message with the marker line \`🪸 jobsync · Coral Labs\` on its own line, followed by a blank line, then your content.

## Step 1: load the user profile
Call \`profile_read\` to retrieve the user's \`skills\`, \`experience\`, \`projects\`, and \`activeRoles\`.

## Step 2: score each job (1–10)
For each job in the list below, assign a **fitScore** from 1–10 using this rubric:

| Dimension | Weight | What to look for |
|---|---|---|
| Skills match | 35% | Does the job's required tech stack appear in the user's skills.md? |
| Experience alignment | 30% | Do the user's past roles / seniority match the JD expectations? |
| Role targeting | 20% | Is this role in the user's \`activeRoles\` list? |
| Growth potential | 15% | Is this a stretch role that fits the user's trajectory without being a mismatch? |

Scoring guide:
- **9–10**: Near-perfect match. User meets almost all requirements.
- **7–8**: Strong match. Minor gaps that are easy to bridge.
- **5–6**: Moderate match. Meaningful gaps but worth applying.
- **3–4**: Weak match. Significant skill or experience gap.
- **1–2**: Poor fit. Mismatch in role, seniority, or tech stack.

Jobs to analyze:
\`\`\`json
${rawJobs}
\`\`\`

## Step 3: output the fit report table

Present the results as a markdown table with color-coded scores. Use these emoji indicators:

- 🟢 = score 8–10 (Strong — apply now)
- 🟡 = score 5–7 (Moderate — worth considering)
- 🔴 = score 1–4 (Weak — likely skip)

Table format:

| Score | Role | Company | Location | Date Posted | Manual Apply | Agentic Apply |
|-------|------|---------|----------|-------------|--------------|---------------|
| 🟢 **9/10** | Software Engineer | Stripe | Remote, USA | ${today} | [Apply ↗](https://example.com) | 🔜 Coming soon |

Rules for the table:
- Sort rows by fitScore descending (highest first).
- For **Manual Apply**: render as a clickable markdown link \`[Apply ↗](url)\`.
- For **Agentic Apply**: always render as \`🔜 Coming soon\` — this feature is not yet live.
- If \`datePosted\` is null or missing, show \`—\`.
- If \`location\` is null, show \`—\`.
- Keep Role and Company columns concise (trim long titles at ~40 chars with "…").

## Step 4: persist to pipeline (mandatory — do not skip)
Call \`pipeline_upsert_jobs\` with an array of objects — one per scored job — using these fields:
\`id\`, \`positionTitle\`, \`company\`, \`location\`, \`applyLink\`, \`datePosted\`, \`industry\`, \`tags\` (comma-joined string), \`fitScore\` (number as string).

This adds new roles as \`pending\` in the pipeline TSV and refreshes metadata for roles already tracked. You MUST call this even when running inline from \`scrape_jobs_workflow\` — it is not optional.

## Step 5: summary line
After the table, add a one-line summary:
> "Analyzed N roles · X strong matches (🟢) · Y moderate (🟡) · Z weak (🔴) · Recommended to apply: [top role names]"
> "Pipeline updated — run the **pipeline_dashboard** prompt any time to track your applications."

## Rules
- Do not fabricate skill matches — only count skills explicitly mentioned in the user's profile.
- If the job has no description, base scoring only on title + company tags + industry.
- Do not exceed 50 jobs in a single analysis run.`;
};

const PIPELINE_DASHBOARD = (_args: Record<string, string>): string => {
  return `You are the JobSync pipeline dashboard. Render the user's complete application pipeline and let them update statuses conversationally.

**Branding rule:** Begin every user-facing message with the marker line \`🪸 jobsync · Coral Labs\` on its own line, followed by a blank line, then your content.

## Step 1: load pipeline
Call \`pipeline_get_status\` with no filter to retrieve all entries grouped by status.

## Step 2: render the dashboard

Output the following sections in order. Omit a section entirely if its count is 0.

---
## 🗂️ Application Pipeline

| Stage | Count |
|-------|-------|
| 🟡 Pending (not yet applied) | N |
| ✅ Applied | N |
| 🔵 Interviewing | N |
| 🟣 Offer received | N |
| ❌ Rejected | N |
| ⬜ Withdrawn | N |
| **Total tracked** | **N** |

---

### 🟡 Pending · N roles to apply to
> Sorted by fit score descending. Click a link, then tell me "I applied to [Company]" to move it forward.

| Fit | Role | Company | Location | Date Posted | Manual Apply | Agentic Apply |
|-----|------|---------|----------|-------------|--------------|---------------|
| 🟢 9/10 | Software Engineer | Stripe | Remote, USA | 2026-04-23 | [Apply ↗](url) | 🔜 Coming soon |

---

### ✅ Applied · N
| Role | Company | Applied On | Notes |
|------|---------|------------|-------|

---

### 🔵 Interviewing · N
| Role | Company | Applied On | Notes |
|------|---------|------------|-------|

---

### 🟣 Offer received · N
| Role | Company | Notes |
|------|---------|-------|

---

### ❌ Rejected · N
| Role | Company | Applied On | Notes |
|------|---------|------------|-------|

---

### ⬜ Withdrawn · N
| Role | Company | Notes |
|------|---------|-------|

---

Rendering rules:
- In the Pending table sort by fitScore descending; empty fitScore sorts last.
- In Applied/Rejected sort by appliedAt descending (most recent first).
- Fit score badge: 🟢 8–10 · 🟡 5–7 · 🔴 1–4 · (blank if unscored).
- Agentic Apply column: always \`🔜 Coming soon\`.
- Trim role titles to 40 chars with "…".
- If notes is empty, show "—".

## Step 3: interactive update loop

After rendering, tell the user:

> **To update a status**, say things like:
> - "I applied to Stripe" → marks that job applied
> - "Mark Airbnb as interviewing"
> - "Reject the Google role, note: no visa sponsorship"
> - "Withdraw Figma"
> - "Show me only pending roles"

Then wait for the user's response and handle it:

**"I applied to [Company]" / "mark [Company] as applied"**
→ find the matching entry by company name, call \`pipeline_mark_applied\` with its applyLink, confirm the update, re-render the Pending and Applied sections only.

**"mark [Company] as [status]"** / **"[Company] is [status]"**
→ call \`pipeline_update_status\` with the resolved applyLink/id and new status, confirm, re-render affected sections.

**"add note: [text] to [Company]"**
→ call \`pipeline_update_status\` with the same status + new notes value.

**"show me only [status] roles"**
→ call \`pipeline_get_status\` with a statusFilter and re-render just that section.

**"refresh"** / **"reload"**
→ call \`pipeline_get_status\` again and re-render the full dashboard.

## Rules
- Always match by company name (case-insensitive) if the user doesn't give an exact apply link.
- If multiple entries share a company name, list them and ask which one.
- Never fabricate pipeline entries — only show what's in the TSV.
- Do not call \`pipeline_upsert_jobs\` from this prompt — that is the fit agent's job.`;
};

const ONBOARD_PROFILE = (_args: Record<string, string>): string => {
  return `You are onboarding the user to JobSync. Build their profile so future scraping runs target the right roles.

**Branding rule:** Begin every user-facing message in this workflow with the marker line \`🪸 jobsync · Coral Labs\` on its own line, followed by a blank line, then your content.

## Step 1: read the raw resume
Call \`profile_read\` and look at \`rawResume\`. If it is empty, tell the user to run \`jobsync-mcp onboard --resume PATH\` first (or to paste their resume text and call \`profile_parse_resume\` on a .txt copy), then stop.

## Step 2: structure the resume into three markdown files
From the raw resume text, produce three concise markdown documents and save each via \`profile_write_file\`:
- \`skills\` — bulleted tech stack, languages, frameworks, tools, domains. Group by category.
- \`experience\` — chronological roles: company, title, dates, seniority level, 1–3 bullets on scope/impact. Note industries.
- \`projects\` — notable projects with tech used and outcome. Personal + work + OSS.

Keep each file under ~2KB. These are meant to be human-editable.

## Step 3: suggest detected roles
Based on the resume, propose 3–7 target role titles (e.g., "AI Engineer", "ML Engineer", "Backend Engineer", "Full-Stack Engineer"). Favor roles the user is *qualified for right now*, not aspirational ones. Save via:
\`profile_update_roles({ detected: [...] })\`

## Step 4: confirm with the user
Show the user:
- The detected role list
- Ask: "Are there roles I missed you want to add?" — collect as \`addCustom\`
- Ask: "Any roles to hard-exclude?" — collect as \`addExcluded\`
Apply their answers via \`profile_update_roles\`.

## Step 4b: detect seniority tier
From the resume (experience.md / raw-resume.txt), classify the user:
- **early-career** — current student, new grad, grad researcher, or ≤1 yr of industry (non-research) experience
- **mid-level** — 2–5 yrs industry exp
- **senior** — 6+ yrs industry exp

Carry this into the portals.yml you generate below.

## Step 5: generate portals.yml
Call \`portals_master_list\` to retrieve the built-in company catalogue, then call \`portals_write\` with a personalized YAML following this exact structure:

\`\`\`yaml
# Portal Scanner Configuration — auto-generated by jobsync onboarding
# Edit any time. Agents read this at the start of every scrape run.

title_filter:
  positive:
    # Derive from activeRoles — map each to 3-8 keyword variants
    - "<keyword>"
  negative:
    # Always include roles.excluded entries plus seniority terms inappropriate for the user's tier.
    # Early-career: always include Senior, Lead, Staff, Principal below.
    # Mid/senior: remove Senior from this list.
    - "Intern"
    - "Director"
    - "Manager"
    - "VP"
    - "Head of"
    # --- include these only for early-career users ---
    - "Principal"
    - "Staff"
    - "Senior"
    - "Lead"
  # early_career_boost — include this block only when seniority tier is early-career.
  # Remove this block entirely for mid-level or senior users.
  early_career_boost:
    - "New Grad"
    - "Entry Level"
    - "Junior"
    - "Associate"
    - "Early Career"
    - "University Grad"
    - "Recent Grad"

search_queries:
  # 8-15 queries covering Ashby, Greenhouse, Lever, and 2-3 broad boards.
  # Early-career: append '"entry level" OR "new grad"' to every query.
  # Mid/senior: no seniority modifier, or append '"Senior"' if desired.
  - name: "<Board> — <Role> (<seniority label>)"
    query: 'site:<ats-domain> "<role>" <seniority_modifier>'
    enabled: true

tracked_companies:
  # 15-30 companies from the master list relevant to the user's industry and roles.
  # Omit unrelated verticals entirely.
  # scan_method values: greenhouse_api | ashby_api | lever_api | websearch
  # Derive scan_method from careers_url:
  #   greenhouse.io  → greenhouse_api
  #   ashbyhq.com    → ashby_api
  #   lever.co       → lever_api
  #   anything else  → websearch (add scan_query)
  - name: "<Company>"
    careers_url: https://...
    scan_method: greenhouse_api   # or ashby_api / lever_api / websearch
    enabled: true
  # For websearch entries also add:
  # scan_query: 'site:<domain> "<role>" "entry level" OR "new grad"'
\`\`\`

**Generation rules:**
1. **title_filter.positive** — derive from \`activeRoles\`. Map each role title to keyword variants.
2. **title_filter.negative** — include every entry from \`roles.excluded\`. For early-career users always add: Senior, Lead, Staff, Principal. For mid/senior users omit those four.
3. **seniority section** — early-career → include \`early_career_boost\` block, omit \`seniority_boost\`. Mid/senior → omit both blocks, or add a \`seniority_boost\` with Senior/Staff/Lead.
4. **search_queries** — 8–15 queries. Cover Ashby, Greenhouse, Lever, and 2–3 broad boards (Wellfound, Himalayas, YC Jobs). Early-career: append \`"entry level" OR "new grad"\` to every query. Mid/senior: no modifier unless user wants senior roles specifically.
5. **tracked_companies** — select from the master list. Match company vertical to user's industry. Set \`scan_method\` based on careers_url pattern (see table above). For websearch entries add a \`scan_query\` that includes the seniority modifier. Set \`enabled: true\` on all selected companies.
6. Preserve the header comments so the user knows what to edit.

After saving, tell the user:
> "Your portals.yml has been created at ~/.jobsync/portals.yml — the scrape workflow will use it automatically. Edit it any time to add companies or adjust keywords."

## Step 6: report
Summarize what was saved (skills.md, experience.md, projects.md, active role count, portals.yml company count) and tell the user they can edit all files directly at ~/.jobsync/ any time.`;
};

export function registerPrompts(): PromptDefinition[] {
  return [
    {
      name: "analyze_job_fit",
      description:
        "Fit-analysis agent: reads the user's profile (skills, experience, active roles) and scores each supplied job on a 1–10 scale. Renders a color-coded markdown table (🟢 strong / 🟡 moderate / 🔴 weak) with manual apply links and an agentic-apply placeholder. Called automatically at the end of scrape_jobs_workflow, or standalone with a JSON jobs array.",
      arguments: [
        {
          name: "jobs",
          description:
            "JSON array of job objects to score. Each object should include: id, positionTitle, company, location, applyLink, datePosted, industry, tags, jobDescription, qualifications. Null fields can be omitted.",
          required: true,
        },
      ],
      render: ANALYZE_JOB_FIT,
    },
    {
      name: "pipeline_dashboard",
      description:
        "Interactive application pipeline dashboard. Reads ~/.jobsync/pipeline.tsv and renders all tracked roles grouped by stage (Pending → Applied → Interviewing → Offer → Rejected → Withdrawn) as color-coded tables. Accepts conversational status updates: 'I applied to Stripe', 'mark Airbnb as interviewing', 'reject Google'. Run this any time to check your job hunt progress.",
      arguments: [],
      render: PIPELINE_DASHBOARD,
    },
    {
      name: "onboard_profile",
      description:
        "One-time onboarding workflow. Reads the parsed resume from ~/.jobsync/profile/raw-resume.txt, structures it into skills/experience/projects markdown files, suggests detected roles, and asks the user to confirm + add custom roles. Run this after `jobsync-mcp onboard --resume PATH`.",
      arguments: [],
      render: ONBOARD_PROFILE,
    },
    {
      name: "scrape_jobs_workflow",
      description:
        "Primary agent workflow: discover job postings via web_search, fetch and classify them, dedup against the local cache and Airtable, then upsert new ones to the user's base. Reads the user's profile for target roles.",
      arguments: [
        {
          name: "companies",
          description:
            "Optional comma-separated list of companies to prioritize in search. If omitted, searches broadly.",
          required: false,
        },
        {
          name: "roleKeywordsOverride",
          description:
            "Optional comma-separated role keywords to override the user profile for a one-off search (e.g., 'SDE, Backend Engineer').",
          required: false,
        },
        {
          name: "lookbackHours",
          description: "Max age of postings in hours. Default 12.",
          required: false,
        },
      ],
      render: SCRAPE_JOBS_WORKFLOW,
    },
    {
      name: "extract_job_fields",
      description:
        "Extraction helper: given a job's title, company, location, and description, returns the prompt to structure it into the ProcessedJob schema (workModel, industry, h1bSponsored, isNewGrad, etc.). Companion to the prompts://extraction-schema resource.",
      arguments: [
        { name: "positionTitle", description: "Job title", required: true },
        { name: "company", description: "Company name", required: true },
        { name: "location", description: "Location string", required: false },
        { name: "jobDescription", description: "Full JD text", required: false },
      ],
      render: EXTRACT_JOB_FIELDS,
    },
  ];
}
