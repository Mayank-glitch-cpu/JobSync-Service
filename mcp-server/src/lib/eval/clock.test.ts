import { describe, it, expect, afterEach } from "vitest";
import { now, isClockFrozen } from "./clock.js";

const ORIGINAL = process.env.JOBSYNC_FAKE_NOW;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.JOBSYNC_FAKE_NOW;
  else process.env.JOBSYNC_FAKE_NOW = ORIGINAL;
});

describe("eval clock", () => {
  it("returns the frozen time when JOBSYNC_FAKE_NOW is a valid ISO date", () => {
    process.env.JOBSYNC_FAKE_NOW = "2026-06-10T12:00:00Z";
    expect(now().toISOString()).toBe("2026-06-10T12:00:00.000Z");
    expect(isClockFrozen()).toBe(true);
  });

  it("falls back to wall clock when unset", () => {
    delete process.env.JOBSYNC_FAKE_NOW;
    const before = Date.now();
    const t = now().getTime();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(isClockFrozen()).toBe(false);
  });

  it("ignores an unparseable JOBSYNC_FAKE_NOW", () => {
    process.env.JOBSYNC_FAKE_NOW = "not-a-date";
    expect(isClockFrozen()).toBe(false);
    // Falls back to wall clock rather than NaN.
    expect(Number.isNaN(now().getTime())).toBe(false);
  });
});
