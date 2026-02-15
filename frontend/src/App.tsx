import { useState, useEffect, useCallback } from 'react';
import { useSSE } from './hooks/useSSE';
import { useApi } from './hooks/useApi';
import { StepPanel } from './components/StepPanel';
import { LogPanel } from './components/LogPanel';
import { DataViewer } from './components/DataViewer';
import { ResizeHandle } from './components/ResizeHandle';
import { VerticalResizeHandle } from './components/VerticalResizeHandle';
import type { JobSource, PipelineStatus } from './types';

const DEFAULT_STATUS: PipelineStatus = {
  step1: { status: 'idle', lastRun: null, jobCount: 0 },
  step2: { status: 'idle', lastRun: null, jobCount: 0 },
  step3: { status: 'idle', lastRun: null, jobCount: 0 },
  step4: { status: 'idle', lastRun: null, jobCount: 0 },
};

export default function App() {
  const { logs, clearLogs } = useSSE();
  const { triggerStep, getStatus, resetPipeline } = useApi();
  const [status, setStatus] = useState<PipelineStatus>(DEFAULT_STATUS);
  const [activeStep, setActiveStep] = useState(1);
  const [refreshKey, setRefreshKey] = useState(0);
  const [source, setSource] = useState<JobSource>('csv');
  const [rangeFrom, setRangeFrom] = useState(1);
  const [rangeTo, setRangeTo] = useState(10);
  const [leftPanelWidth, setLeftPanelWidth] = useState(440);
  const [stepPanelHeight, setStepPanelHeight] = useState(560);

  // Poll pipeline status every second
  useEffect(() => {
    const poll = () => {
      getStatus()
        .then(setStatus)
        .catch(() => {});
    };
    poll();
    const interval = setInterval(poll, 1000);
    return () => clearInterval(interval);
  }, [getStatus]);

  // Refresh data viewer when a step completes
  useEffect(() => {
    setRefreshKey((k) => k + 1);
  }, [
    status.step1.status,
    status.step2.status,
    status.step3.status,
    status.step4.status,
  ]);

  const handleTrigger = useCallback(
    async (step: number) => {
      try {
        await triggerStep(step, source, { from: rangeFrom, to: rangeTo });
        setActiveStep(step);
      } catch (err) {
        console.error('Trigger failed:', err);
      }
    },
    [triggerStep, source, rangeFrom, rangeTo]
  );

  const handleReset = useCallback(async () => {
    await resetPipeline();
    setStatus(DEFAULT_STATUS);
    clearLogs();
    setActiveStep(1);
  }, [resetPipeline, clearLogs]);

  return (
    <div className="app">
      <header className="app-header">
        <h1>JobsList Pipeline</h1>
        <span className="app-subtitle">Developer Dashboard</span>
      </header>
      <div className="app-body">
        <div className="left-panel" style={{ width: leftPanelWidth }}>
          <div className="step-panel-wrapper" style={{ height: stepPanelHeight }}>
            <StepPanel
              status={status}
              activeStep={activeStep}
              source={source}
              onSourceChange={setSource}
              rangeFrom={rangeFrom}
              rangeTo={rangeTo}
              onRangeFromChange={setRangeFrom}
              onRangeToChange={setRangeTo}
              onTrigger={handleTrigger}
              onSelectStep={setActiveStep}
              onReset={handleReset}
            />
          </div>
          <VerticalResizeHandle onResize={setStepPanelHeight} minHeight={200} maxHeight={600} />
          <DataViewer step={activeStep} refreshKey={refreshKey} />
        </div>
        <ResizeHandle onResize={setLeftPanelWidth} minWidth={300} maxWidth={800} />
        <div className="right-panel">
          <LogPanel logs={logs} onClear={clearLogs} />
        </div>
      </div>
    </div>
  );
}
