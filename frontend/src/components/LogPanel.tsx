import { useEffect, useRef, useState } from 'react';
import type { LogEntry } from '../types';

interface LogPanelProps {
  logs: LogEntry[];
  onClear: () => void;
}

type FilterStep = 'all' | LogEntry['step'];

const STEP_COLORS: Record<string, string> = {
  fetch: '#60a5fa',
  scrape: '#34d399',
  ai: '#c084fc',
  sync: '#fb923c',
  system: '#94a3b8',
};

const LEVEL_COLORS: Record<string, string> = {
  error: '#f87171',
  warn: '#fbbf24',
  info: '#e2e8f0',
  debug: '#64748b',
};

export function LogPanel({ logs, onClear }: LogPanelProps) {
  const [filter, setFilter] = useState<FilterStep>('all');
  const [autoScroll, setAutoScroll] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered =
    filter === 'all' ? logs : logs.filter((l) => l.step === filter);

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [filtered.length, autoScroll]);

  const handleScroll = () => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    // Auto-scroll if near bottom
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 50);
  };

  const formatTime = (ts: string) => {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-US', { hour12: false });
  };

  return (
    <div className="log-panel">
      <div className="log-header">
        <h2>Logs</h2>
        <div className="log-controls">
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as FilterStep)}
            className="log-filter"
          >
            <option value="all">All</option>
            <option value="fetch">Fetch</option>
            <option value="scrape">Scrape</option>
            <option value="ai">AI</option>
            <option value="sync">Sync</option>
            <option value="system">System</option>
          </select>
          <button className="log-clear-btn" onClick={onClear}>
            Clear
          </button>
        </div>
      </div>
      <div
        className="log-container"
        ref={containerRef}
        onScroll={handleScroll}
      >
        {filtered.length === 0 && (
          <div className="log-empty">No logs yet. Trigger a step to begin.</div>
        )}
        {filtered.map((entry, i) => (
          <div key={i} className={`log-entry log-level-${entry.level}`}>
            <span className="log-time">{formatTime(entry.timestamp)}</span>
            <span
              className="log-step-badge"
              style={{ backgroundColor: STEP_COLORS[entry.step] || '#64748b' }}
            >
              {entry.step}
            </span>
            <span
              className="log-message"
              style={{ color: LEVEL_COLORS[entry.level] || '#e2e8f0' }}
            >
              {entry.message}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
