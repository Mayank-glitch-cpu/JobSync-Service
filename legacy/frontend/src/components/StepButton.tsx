import type { StepState } from '../types';

interface StepButtonProps {
  stepNumber: number;
  label: string;
  status: StepState;
  jobCount: number;
  disabled: boolean;
  active: boolean;
  onClick: () => void;
  onSelect: () => void;
}

const STATUS_ICONS: Record<StepState, string> = {
  idle: '',
  running: '',
  completed: '',
  error: '',
};

const STATUS_LABELS: Record<StepState, string> = {
  idle: 'Ready',
  running: 'Running...',
  completed: 'Done',
  error: 'Failed',
};

export function StepButton({
  stepNumber,
  label,
  status,
  jobCount,
  disabled,
  active,
  onClick,
  onSelect,
}: StepButtonProps) {
  return (
    <div
      className={`step-card ${active ? 'active' : ''} ${status}`}
      onClick={onSelect}
    >
      <div className="step-header">
        <span className="step-number">{stepNumber}</span>
        <span className="step-label">{label}</span>
        <span className={`step-status-badge ${status}`}>
          {STATUS_ICONS[status]} {STATUS_LABELS[status]}
        </span>
      </div>
      <div className="step-footer">
        {status === 'completed' && (
          <span className="step-count">{jobCount} jobs</span>
        )}
        {status === 'error' && (
          <span className="step-error-hint">Check logs for details</span>
        )}
        <button
          className="step-trigger-btn"
          disabled={disabled || status === 'running'}
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
        >
          {status === 'running' ? 'Running...' : 'Run'}
        </button>
      </div>
    </div>
  );
}
