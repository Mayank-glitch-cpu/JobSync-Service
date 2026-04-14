export interface RawJob {
  id: string;
  positionTitle: string;
  company: string;
  location: string | null;
  applyLink: string | null;
  datePosted: string | null;
  salary: string | null;
  rawFields: Record<string, string>;
}

export interface ScrapedJob extends RawJob {
  jobDescription: string | null;
  scrapeStatus: 'success' | 'failed' | 'skipped';
  scrapeError?: string;
}

export type JobBoard = 'Lever' | 'Ashby' | 'Linkedin' | 'Greenhouse' | 'Workday' | null;

export interface ProcessedJob extends ScrapedJob {
  workModel: 'Onsite' | 'Remote' | 'Hybrid' | null;
  industry: string | null;
  h1bSponsored: boolean;
  qualifications: string | null;
  jobBoard: JobBoard;
  tags: string[];
  isNewGrad: boolean;
  isInternship: boolean;
  aiConfidence: number | null;
  aiProcessed: boolean;
}

export interface SyncedJob extends ProcessedJob {
  airtableRecordId: string | null;
  syncedToAirtable: boolean;
  syncError?: string;
}

export type StepState = 'idle' | 'pending' | 'running' | 'completed' | 'error';

export interface StepStatus {
  status: StepState;
  lastRun: string | null;
  jobCount: number;
  error?: string;
}

export interface PipelineStatus {
  step1: StepStatus;
  step2: StepStatus;
  step3: StepStatus;
  step4: StepStatus;
}

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  step: 'fetch' | 'scrape' | 'ai' | 'sync' | 'system';
  message: string;
  data?: unknown;
}

export type StepName =
  | 'step1-raw-jobs'
  | 'step2-scraped-jobs'
  | 'step3-processed-jobs'
  | 'step4-synced-jobs';
