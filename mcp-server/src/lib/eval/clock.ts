// Frozen-clock helper for the eval harness.
//
// Recency checks ("is this job within the lookback window?") are only meaningful
// against the date the fixtures were recorded, not wall-clock time. Set
// JOBSYNC_FAKE_NOW (ISO 8601) in the eval container so "now" is pinned to the
// fixture snapshot date + a small offset. In production the var is unset and this
// returns the real time, so it's a no-op outside evals.

/** Current time — the frozen JOBSYNC_FAKE_NOW in evals, else the wall clock. */
export function now(): Date {
  const fake = process.env.JOBSYNC_FAKE_NOW;
  if (fake) {
    const ms = Date.parse(fake);
    if (!Number.isNaN(ms)) return new Date(ms);
  }
  return new Date();
}

/** True when a frozen clock is in effect (an eval run). */
export function isClockFrozen(): boolean {
  const fake = process.env.JOBSYNC_FAKE_NOW;
  return Boolean(fake) && !Number.isNaN(Date.parse(fake!));
}
