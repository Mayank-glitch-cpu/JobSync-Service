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

## Step 0: anchor on today's date
Run a bash/date command to get the current UTC timestamp. Confirm the year and use it in all search queries — stale caches are a common failure mode.

## Step 1: load the user profile
Call \`profile_read\` to load the user's detected + custom roles from ~/.jobsync/profile/roles.json. Use the union of \`detected\` + \`custom\` minus \`excluded\` as the target role list.
${rolesOverride ? `\n**Override for this run:** use these role keywords instead of the profile: ${rolesOverride}` : ""}

## Step 2: discover postings via web_search
For each target role, run date-aware queries like:
  "site:jobs.lever.co <role> USA ${new Date().getFullYear()}"
  "site:boards.greenhouse.io <role> entry level USA ${new Date().getFullYear()}"
  "site:jobs.ashbyhq.com <role> new grad USA ${new Date().getFullYear()}"
${companies ? `\nPrioritize these companies first: ${companies}` : ""}

## Step 3: fetch postings via web_fetch
For each search result URL, call web_fetch. If it returns url_not_accessible or url_not_allowed, skip it and move on — do not retry.

## Step 4: classify
Call \`classify_job_batch\` with the parsed jobs. It returns which jobs pass the US/title/keyword filters and enriches each with industry, tags (FAANG+, Quant, YC, etc.), H1B sponsor flag, and detected job board.

## Step 5: verify links are live
For jobs that passed classification, call \`verify_job_link_batch\` with their apply links (max 20 per call; batch if needed).
- Discard any job where \`active: false\` — the posting is closed, removed, or returning a 404. Do not upsert or cache dead links.
- Jobs where \`active: true\` (or the check errored with a network issue) proceed to the next step.

## Step 6: dedup (hybrid)
For jobs that passed link verification, call \`cache_is_seen\` with their apply links. For any that show \`seen: false\`, also call \`airtable_list_recent_jobs\` with lookbackDays=14 and cross-check — the cache can be stale.

## Step 7: enrich & write
For jobs that are new (not in cache, not in Airtable), write them using the sink configured in \`~/.jobsync/config.json\`:
- If \`sink\` is \`"airtable"\` or \`"both"\`: call \`airtable_upsert_job\`.
- If \`sink\` is \`"markdown"\` or \`"both"\`: call \`markdown_append_jobs\` to append a row to the local markdown log.

If unsure which sink is active, call \`profile_read\` first — you can also check config via \`airtable_get_schema\` (it returns the active baseId/tableName; empty strings mean markdown-only). Only include jobs posted within the last ${lookbackHours} hours based on their datePosted. Discard older postings.

## Step 8: update cache
After successful upsert, call \`cache_mark_seen\` with the created jobs so the next run skips them.

## Rules
- USA locations only unless the user explicitly overrides.
- Year must be ${new Date().getFullYear()}.
- Do not fabricate data. If a field is missing from the posting, leave it null — the user can edit in Airtable.
- Do not exceed 50 postings per run unless the user asks.
- Report a short summary at the end: how many searched, how many passed filters, how many were live (link verified), how many were new, how many were duplicates.`;
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

const ONBOARD_PROFILE = (_args: Record<string, string>): string => {
  return `You are onboarding the user to JobSync. Build their profile so future scraping runs target the right roles.

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

## Step 5: report
Summarize what was saved (file sizes, active role count) and tell the user they can edit the markdown files directly at ~/.jobsync/profile/ any time.`;
};

export function registerPrompts(): PromptDefinition[] {
  return [
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
