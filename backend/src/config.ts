import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env from project root (one level up from backend/)
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  googleSheetsCsvUrl:
    process.env.GOOGLE_SHEETS_CSV_URL ||
    'https://docs.google.com/spreadsheets/d/1W6jVjtZ1T3rtIbcw9HWJcdm2vAXjoKD08y8qeZNgk_Q/export?format=csv&gid=550557022',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  claudeModel: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
  airtableApiKey: process.env.AIRTABLE_API_KEY || '',
  airtableBaseId: process.env.AIRTABLE_BASE_ID || '',
  airtableTableName: process.env.AIRTABLE_TABLE_NAME || 'Jobs',
  jobCount: parseInt(process.env.JOB_COUNT || '10', 10),
  rapidApiKey: process.env.RAPIDAPI_KEY || '',
  jsearchQuery: process.env.JSEARCH_QUERY || 'software developer jobs in USA',
  jsearchNumPages: parseInt(process.env.JSEARCH_NUM_PAGES || '1', 10),
  ashbyKeywords: (process.env.ASHBY_KEYWORDS || 'software,robotics,manufacturing,data analyst,sde,early career')
    .split(',')
    .map((keyword) => keyword.trim().toLowerCase())
    .filter(Boolean),
  ashbyPublishedWithinHours: (() => {
    const parsed = parseInt(
      process.env.ASHBY_PUBLISHED_WITHIN_HOURS || '24',
      10
    );
    const safe = Number.isNaN(parsed) ? 24 : parsed;
    return safe < 0 ? 0 : safe;
  })(),
  ashbyIncludeCompensation:
    (process.env.ASHBY_INCLUDE_COMPENSATION || 'true').toLowerCase() === 'true',
  ashbyRequestDelayMs: parseInt(process.env.ASHBY_REQUEST_DELAY_MS || '1000', 10),
  ashbyExcludeKeywords: (process.env.ASHBY_EXCLUDE_KEYWORDS || 'senior,staff,principal,lead,director,manager,head of,vp,chief,architect,account,sales,marketing,recruiter,recruiting,warehouse,operations,designer,ghostwriter,revenue,business development,customer success,onboarding,payroll,people,planning,field engineer,solutions engineer,implementation,back of house,retail,support engineer,technical support,community,partnerships,strategy,finance,legal,hr ,copywriter,content')
    .split(',')
    .map((keyword) => keyword.trim().toLowerCase())
    .filter(Boolean),
  ashbyIncludeKeywords: (process.env.ASHBY_INCLUDE_KEYWORDS || 'engineer,developer,software,programmer,data,machine learning,ml,ai,nlp,scientist,researcher,robotics,mlops,devops,sre,infrastructure,platform,backend,frontend,fullstack,full stack,firmware,embedded')
    .split(',')
    .map((keyword) => keyword.trim().toLowerCase())
    .filter(Boolean),
  ashbyUsOnly:
    (process.env.ASHBY_US_ONLY || 'true').toLowerCase() === 'true',
  pipelineApiKey: process.env.PIPELINE_API_KEY || '',

  // Adzuna (optional — free tier: 250 req/month)
  adzunaAppId: process.env.ADZUNA_APP_ID || '',
  adzunaAppKey: process.env.ADZUNA_APP_KEY || '',

  // USAJobs (optional — free, unlimited)
  usajobsApiKey: process.env.USAJOBS_API_KEY || '',
  usajobsEmail: process.env.USAJOBS_EMAIL || '',

  // Google Custom Search (Ashby discovery)
  googleApiKey: process.env.GOOGLE_API_KEY || '',
  googleCseId: process.env.GOOGLE_CSE_ID || '',
};
