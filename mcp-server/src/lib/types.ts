// Copy of the job-domain types from backend/src/types.ts. Kept in sync manually
// until the legacy pipeline is retired.

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
  scrapeStatus: "success" | "failed" | "skipped";
  scrapeError?: string;
}

export type JobBoard =
  | "Lever"
  | "Ashby"
  | "Linkedin"
  | "Greenhouse"
  | "Workday"
  | null;

export interface ProcessedJob extends ScrapedJob {
  workModel: "Onsite" | "Remote" | "Hybrid" | null;
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
