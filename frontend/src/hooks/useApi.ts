import { useCallback } from 'react';
import type { JobSource, PipelineStatus } from '../types';

export function useApi() {
  const triggerStep = useCallback(async (
    step: number,
    source?: JobSource,
    range?: { from: number; to: number }
  ): Promise<void> => {
    const searchParams = new URLSearchParams();
    if (step === 1 && source) searchParams.set('source', source);
    if (step === 1 && range) {
      searchParams.set('from', String(range.from));
      searchParams.set('to', String(range.to));
    }
    const qs = searchParams.toString();
    const res = await fetch(`/api/pipeline/step${step}${qs ? `?${qs}` : ''}`, { method: 'POST' });
    if (!res.ok) {
      const body = await res.json();
      throw new Error(body.error || `Failed to trigger step ${step}`);
    }
  }, []);

  const getStatus = useCallback(async (): Promise<PipelineStatus> => {
    const res = await fetch('/api/pipeline/status');
    return res.json();
  }, []);

  const getStepData = useCallback(async (step: number): Promise<{ jobs: unknown[] }> => {
    const res = await fetch(`/api/data/${step}`);
    return res.json();
  }, []);

  const resetPipeline = useCallback(async (): Promise<void> => {
    await fetch('/api/pipeline/reset', { method: 'POST' });
  }, []);

  return { triggerStep, getStatus, getStepData, resetPipeline };
}
