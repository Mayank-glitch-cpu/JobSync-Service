import { StepButton } from './StepButton';
import type { JobSource, PipelineStatus } from '../types';

interface StepPanelProps {
  status: PipelineStatus;
  activeStep: number;
  source: JobSource;
  onSourceChange: (source: JobSource) => void;
  rangeFrom: number;
  rangeTo: number;
  onRangeFromChange: (val: number) => void;
  onRangeToChange: (val: number) => void;
  onTrigger: (step: number) => void;
  onSelectStep: (step: number) => void;
  onReset: () => void;
}

interface SourceEntry {
  key: JobSource;
  label: string;
}

interface SourceGroup {
  title: string;
  sources: SourceEntry[];
}

const SOURCE_GROUPS: SourceGroup[] = [
  {
    title: 'Multi-Source',
    sources: [
      { key: 'free', label: 'All Free' },
      { key: 'multi', label: 'All Sources' },
      { key: 'premium', label: 'Premium' },
    ],
  },
  {
    title: 'Original',
    sources: [
      { key: 'csv', label: 'Google Sheets' },
      { key: 'github', label: 'GitHub' },
      { key: 'theirstack', label: 'Ashby' },
      { key: 'jsearch', label: 'JSearch' },
      { key: 'yc', label: 'Y Combinator' },
    ],
  },
  {
    title: 'Free Sources',
    sources: [
      { key: 'remotive', label: 'Remotive' },
      { key: 'remoteok', label: 'RemoteOK' },
      { key: 'arbeitnow', label: 'Arbeitnow' },
      { key: 'hackernews', label: 'HN Hiring' },
      { key: 'greenhouse', label: 'Greenhouse' },
      { key: 'lever', label: 'Lever' },
      { key: 'wellfound', label: 'Wellfound' },
      { key: 'himalayas', label: 'Himalayas' },
      { key: 'jobicy', label: 'Jobicy' },
      { key: 'smartrecruiters', label: 'SmartRecruiters' },
      { key: 'workday', label: 'Workday' },
      { key: 'recruitee', label: 'Recruitee' },
      { key: 'workable', label: 'Workable' },
    ],
  },
  {
    title: 'API Key Required',
    sources: [
      { key: 'ashby-google', label: 'Ashby Google' },
      { key: 'adzuna', label: 'Adzuna' },
      { key: 'usajobs', label: 'USAJobs' },
      { key: 'linkedin', label: 'LinkedIn' },
    ],
  },
];

const STEP1_LABELS: Record<string, string> = {
  csv: 'Fetch CSV',
  github: 'Fetch GitHub',
  yc: 'Fetch YC',
  jsearch: 'Fetch JSearch',
  theirstack: 'Fetch Ashby',
  remotive: 'Fetch Remotive',
  remoteok: 'Fetch RemoteOK',
  adzuna: 'Fetch Adzuna',
  hackernews: 'Fetch HN',
  arbeitnow: 'Fetch Arbeitnow',
  usajobs: 'Fetch USAJobs',
  greenhouse: 'Fetch Greenhouse',
  lever: 'Fetch Lever',
  linkedin: 'Fetch LinkedIn',
  wellfound: 'Fetch Wellfound',
  himalayas: 'Fetch Himalayas',
  jobicy: 'Fetch Jobicy',
  'ashby-google': 'Fetch Ashby Google',
  smartrecruiters: 'Fetch SmartRecruiters',
  workday: 'Fetch Workday',
  recruitee: 'Fetch Recruitee',
  workable: 'Fetch Workable',
  free: 'Fetch Free Sources',
  multi: 'Fetch All Sources',
  premium: 'Fetch Premium',
};

export function StepPanel({
  status,
  activeStep,
  source,
  onSourceChange,
  rangeFrom,
  rangeTo,
  onRangeFromChange,
  onRangeToChange,
  onTrigger,
  onSelectStep,
  onReset,
}: StepPanelProps) {
  const stepStatuses = [status.step1, status.step2, status.step3, status.step4];
  const isAnyRunning = stepStatuses.some((s) => s.status === 'running');

  const labels: Record<number, string> = {
    1: STEP1_LABELS[source] || 'Fetch Jobs',
    2: 'Scrape JDs',
    3: 'AI Process',
    4: 'Sync Airtable',
  };

  return (
    <div className="step-panel">
      <div className="step-panel-header">
        <h2>Pipeline Steps</h2>
        <button
          className="reset-btn"
          onClick={onReset}
          disabled={isAnyRunning}
        >
          Reset All
        </button>
      </div>
      <div className="source-selector">
        <label className="source-label">Source:</label>
        {SOURCE_GROUPS.map((group) => (
          <div key={group.title} className="source-group">
            <span className="source-group-label">{group.title}</span>
            <div className="source-group-btns">
              {group.sources.map((s) => (
                <button
                  key={s.key}
                  className={`source-btn ${source === s.key ? 'active' : ''}`}
                  onClick={() => onSourceChange(s.key)}
                  disabled={isAnyRunning}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="range-selector">
        <label className="source-label">Range (newest first):</label>
        <input
          type="number"
          className="range-input"
          value={rangeFrom}
          min={1}
          onChange={(e) => onRangeFromChange(Math.max(1, parseInt(e.target.value) || 1))}
          disabled={isAnyRunning}
        />
        <span className="range-separator">to</span>
        <input
          type="number"
          className="range-input"
          value={rangeTo}
          min={1}
          onChange={(e) => onRangeToChange(Math.max(1, parseInt(e.target.value) || 1))}
          disabled={isAnyRunning}
        />
      </div>
      <div className="step-list">
        {[1, 2, 3, 4].map((num, idx) => {
          const stepStatus = stepStatuses[idx];
          const prevCompleted =
            idx === 0 || stepStatuses[idx - 1].status === 'completed';
          const disabled = isAnyRunning || !prevCompleted;

          return (
            <StepButton
              key={num}
              stepNumber={num}
              label={labels[num]}
              status={stepStatus.status}
              jobCount={stepStatus.jobCount}
              disabled={disabled}
              active={activeStep === num}
              onClick={() => onTrigger(num)}
              onSelect={() => onSelectStep(num)}
            />
          );
        })}
      </div>
    </div>
  );
}
