// Airtable Meta API wrapper: list workspaces/bases and create a new base
// with the exact schema mapToAirtableRecord writes. Requires a PAT with
// the `schema.bases:write` scope.

const META_BASE_URL = "https://api.airtable.com/v0/meta";

async function airtableFetch<T>(
  path: string,
  pat: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${META_BASE_URL}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${pat}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Airtable ${path} → ${res.status}: ${body}`);
  }
  return (await res.json()) as T;
}

export interface BaseSummary {
  id: string;
  name: string;
  permissionLevel: string;
}

export async function listBases(pat: string): Promise<BaseSummary[]> {
  const data = await airtableFetch<{ bases: BaseSummary[] }>("/bases", pat);
  return data.bases;
}

const JOBS_TABLE_FIELDS = [
  { name: "Position Title", type: "singleLineText" },
  { name: "Company", type: "singleLineText" },
  { name: "Date", type: "date", options: { dateFormat: { name: "iso", format: "YYYY-MM-DD" } } },
  { name: "Apply Link", type: "url" },
  { name: "Location", type: "singleLineText" },
  {
    name: "Work Model",
    type: "singleSelect",
    options: { choices: [{ name: "Onsite" }, { name: "Remote" }, { name: "Hybrid" }] },
  },
  { name: "Industry", type: "singleLineText" },
  { name: "Salary", type: "singleLineText" },
  { name: "Job Description", type: "multilineText" },
  { name: "Qualifications", type: "multilineText" },
  {
    name: "Tags",
    type: "multipleSelects",
    options: {
      choices: [
        { name: "FAANG+" },
        { name: "Quant" },
        { name: "YC" },
        { name: "Fortune 500" },
        { name: "Unicorn" },
        { name: "Crypto/Web3" },
        { name: "H1B Sponsor" },
      ],
    },
  },
  {
    name: "JobBoard",
    type: "singleSelect",
    options: {
      choices: [
        { name: "Lever" },
        { name: "Ashby" },
        { name: "Greenhouse" },
        { name: "Workday" },
        { name: "Linkedin" },
      ],
    },
  },
  { name: "H1B Sponsored", type: "checkbox", options: { icon: "check", color: "greenBright" } },
  { name: "Is New Grad", type: "checkbox", options: { icon: "check", color: "blueBright" } },
  { name: "Is Internship", type: "checkbox", options: { icon: "check", color: "yellowBright" } },
];

export interface CreateBaseResult {
  id: string;
  tables: Array<{ id: string; name: string }>;
}

export async function createJobSyncBase(
  pat: string,
  workspaceId: string,
  name = "JobSync",
): Promise<CreateBaseResult> {
  return airtableFetch<CreateBaseResult>("/bases", pat, {
    method: "POST",
    body: JSON.stringify({
      name,
      workspaceId,
      tables: [{ name: "Jobs", fields: JOBS_TABLE_FIELDS }],
    }),
  });
}
