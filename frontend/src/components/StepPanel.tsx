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

const STEP_LABELS: Record<string, Record<number, string>> = {
  csv: { 1: 'Fetch CSV', 2: 'Scrape JDs', 3: 'AI Process', 4: 'Sync Airtable' },
  github: { 1: 'Fetch GitHub', 2: 'Scrape JDs', 3: 'AI Process', 4: 'Sync Airtable' },
  yc: { 1: 'Fetch YC', 2: 'Scrape JDs', 3: 'AI Process', 4: 'Sync Airtable' },
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
  const labels = STEP_LABELS[source];

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
        <button
          className={`source-btn ${source === 'csv' ? 'active' : ''}`}
          onClick={() => onSourceChange('csv')}
          disabled={isAnyRunning}
        >
          Google Sheets
        </button>
        <button
          className={`source-btn ${source === 'github' ? 'active' : ''}`}
          onClick={() => onSourceChange('github')}
          disabled={isAnyRunning}
        >
          GitHub
        </button>
        <button
          className={`source-btn ${source === 'yc' ? 'active' : ''}`}
          onClick={() => onSourceChange('yc')}
          disabled={isAnyRunning}
        >
          Y Combinator
        </button>
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
