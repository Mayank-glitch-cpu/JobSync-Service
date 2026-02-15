export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  step: 'fetch' | 'scrape' | 'ai' | 'sync' | 'system';
  message: string;
  data?: unknown;
}

export type JobSource =
  | 'csv'
  | 'github'
  | 'yc'
  | 'jsearch'
  | 'theirstack'
  | 'remotive'
  | 'remoteok'
  | 'adzuna'
  | 'hackernews'
  | 'arbeitnow'
  | 'usajobs'
  | 'greenhouse'
  | 'lever'
  | 'linkedin'
  | 'wellfound'
  | 'himalayas'
  | 'jobicy'
  | 'ashby-google'
  | 'free'
  | 'multi'
  | 'premium';

export type StepState = 'idle' | 'running' | 'completed' | 'error';

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
