import Airtable from 'airtable';
import { config } from '../config.js';
import { log } from '../logger.js';
import { readStep, writeStep } from '../store.js';
import type { ProcessedJob, SyncedJob } from '../types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mapToAirtableRecord(job: ProcessedJob): Record<string, unknown> {
  return {
    'Position Title': job.positionTitle,
    Date: (job.datePosted || '').split('T')[0],
    'Apply Link': job.applyLink || '',
    'Work Model': job.workModel || 'Onsite',
    Location: job.location || 'Not specified',
    Company: job.company,
    ...(job.tags?.length ? { Tags: job.tags } : {}),
    Industry: job.industry || 'Software Engineering',
    Salary: job.salary || 'Not listed',
    'Job Description': (job.jobDescription || '').slice(0, 100000), // Airtable long text limit
    Qualifications: job.qualifications || '',
    ...(job.jobBoard ? { JobBoard: job.jobBoard } : {}),
    'H1B Sponsored': job.h1bSponsored ?? false,
    'Is New Grad': job.isNewGrad ?? false,
    'Is Internship': job.isInternship ?? false,
  };
}

export async function syncToAirtable(): Promise<number> {
  if (!config.airtableApiKey || !config.airtableBaseId) {
    throw new Error('AIRTABLE_API_KEY and AIRTABLE_BASE_ID must be set in .env');
  }

  const allJobs = readStep<ProcessedJob[]>('step3-processed-jobs');
  if (!allJobs || allJobs.length === 0) {
    throw new Error('No jobs found from Step 3. Run Step 3 first.');
  }

  // Validate: reject jobs missing critical fields or with invalid/placeholder values
  const INVALID_VALUES = ['unknown company', 'unknown position', 'unknown', 'n/a', 'none', ''];
  const jobs: ProcessedJob[] = [];
  const rejected: ProcessedJob[] = [];

  for (const job of allJobs) {
    const reasons: string[] = [];
    if (!job.datePosted) reasons.push('missing datePosted');
    if (!job.positionTitle) reasons.push('missing positionTitle');
    if (!job.company) reasons.push('missing company');
    if (!job.applyLink) reasons.push('missing applyLink');

    const companyLower = (job.company || '').trim().toLowerCase();
    const titleLower = (job.positionTitle || '').trim().toLowerCase();
    if (INVALID_VALUES.includes(companyLower)) reasons.push(`invalid company: "${job.company}"`);
    if (INVALID_VALUES.includes(titleLower)) reasons.push(`invalid title: "${job.positionTitle}"`);

    if (reasons.length > 0) {
      rejected.push(job);
      log('sync', 'warn', `  Rejected: ${job.company || 'Unknown'} — ${job.positionTitle || 'Unknown'} (${reasons.join(', ')})`);
    } else {
      jobs.push(job);
    }
  }

  if (rejected.length > 0) {
    log('sync', 'warn', `Pre-sync validation: ${rejected.length} job(s) rejected for missing critical fields`);
  }

  if (jobs.length === 0) {
    throw new Error('No valid jobs remaining after pre-sync validation.');
  }

  log('sync', 'info', `Starting Airtable sync for ${jobs.length} jobs (${rejected.length} rejected)...`);

  const base = new Airtable({ apiKey: config.airtableApiKey }).base(config.airtableBaseId);
  const table = base(config.airtableTableName);

  const results: SyncedJob[] = [];

  // Batch create in groups of 10 (Airtable limit)
  for (let i = 0; i < jobs.length; i += 10) {
    const batch = jobs.slice(i, i + 10);
    const records = batch.map((job) => ({
      fields: mapToAirtableRecord(job),
    }));

    try {
      log(
        'sync',
        'info',
        `  Syncing batch ${Math.floor(i / 10) + 1} (${batch.length} records)...`
      );
      log('sync', 'debug', `  Batch fields sample: ${JSON.stringify(records[0]?.fields)}`);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const created = await (table as any).create(records);
      const createdArr = created as unknown as Array<{ id: string }>;

      for (let j = 0; j < createdArr.length; j++) {
        const synced: SyncedJob = {
          ...batch[j],
          airtableRecordId: createdArr[j].id,
          syncedToAirtable: true,
        };
        results.push(synced);
        log('sync', 'info', `  ${batch[j].company} — Synced (${createdArr[j].id})`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log('sync', 'error', `  Batch failed: ${msg}`);

      // Mark all in this batch as failed
      for (const job of batch) {
        results.push({
          ...job,
          airtableRecordId: null,
          syncedToAirtable: false,
          syncError: msg,
        });
      }
    }

    // Rate limiting: 200ms between batches (Airtable allows 5 req/sec)
    if (i + 10 < jobs.length) {
      await sleep(250);
    }
  }

  const synced = results.filter((j) => j.syncedToAirtable).length;
  writeStep('step4-synced-jobs', results);
  log('sync', 'info', `Step 4 complete: ${synced}/${results.length} jobs synced to Airtable`);
  return results.length;
}
