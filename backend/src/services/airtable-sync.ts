import Airtable from 'airtable';
import { config } from '../config.js';
import { log } from '../logger.js';
import { readStep, writeStep } from '../store.js';
import type { ProcessedJob, SyncedJob } from '../types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mapToAirtableRecord(job: ProcessedJob): Record<string, unknown> {
  return {
    'Position Title': job.positionTitle,
    Date: job.datePosted || null,
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

  const jobs = readStep<ProcessedJob[]>('step3-processed-jobs');
  if (!jobs || jobs.length === 0) {
    throw new Error('No jobs found from Step 3. Run Step 3 first.');
  }

  log('sync', 'info', `Starting Airtable sync for ${jobs.length} jobs...`);

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
