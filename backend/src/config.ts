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
    'https://docs.google.com/spreadsheets/d/1W6jVjtZ1T3rtIbcw9HWJcdm2vAXjoKD08y8qeZNgk_Q/export?format=csv&gid=593160555',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  claudeModel: process.env.CLAUDE_MODEL || 'claude-3-5-haiku-20241022',
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
  ashbyExcludeKeywords: (process.env.ASHBY_EXCLUDE_KEYWORDS || 'senior,staff,principal,lead,director,manager')
    .split(',')
    .map((keyword) => keyword.trim().toLowerCase())
    .filter(Boolean),
  pipelineApiKey: process.env.PIPELINE_API_KEY || '',
};
