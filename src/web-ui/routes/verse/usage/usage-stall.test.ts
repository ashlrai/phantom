/**
 * usage-stall.test.ts — verify the stall-detection logic for the usage
 * section: detect when a provider usage meter has stopped moving while
 * workers were running.
 */
import { describe, expect, it } from 'vitest';
import { usageStall, type UsageSample } from './usage-stall.js';

function sample(
  minutesAgo: number,
  pct: number | null,
  workers: number | null,
): UsageSample {
  return {
    at: Date.now() - minutesAgo * 60_000,
    usedPct: pct,
    workersRunning: workers,
  };
}

function now(): number {
  return Date.now();
}

describe('usageStall', () => {
  it('returns empty result for no input', () => {
    const result = usageStall([], now());
    expect(result).toEqual({
      stalled: false,
      unchangedMinutes: null,
      lastChangeAt: null,
      usedPct: null,
      workersSeen: 0,
    });
  });

  it('flat 70 min with 24 workers → stalled true, unchangedMinutes 70, workersSeen 24', () => {
    const samples: UsageSample[] = [];
    for (let m = 0; m <= 70; m += 1) {
      samples.push(sample(m, 64, 24));
    }
    const result = usageStall(samples, now(), 60);
    expect(result.stalled).toBe(true);
    expect(result.unchangedMinutes).toBe(70);
    expect(result.workersSeen).toBe(24);
    expect(result.usedPct).toBe(64);
  });

  it('flat 70 min with 0 workers → stalled false', () => {
    const samples: UsageSample[] = [];
    for (let m = 0; m <= 70; m += 1) {
      samples.push(sample(m, 64, 0));
    }
    const result = usageStall(samples, now(), 60);
    expect(result.stalled).toBe(false);
    expect(result.unchangedMinutes).toBe(70);
    expect(result.workersSeen).toBe(0);
  });

  it('moving meter (64 → 66, change 50 min ago) → unchangedMinutes ~50, stalled false', () => {
    // 6 samples at 64 (m=50-55), 6 samples at 66 (m=44-49).
    // Newest is 66 (m=49). Walking backwards: all 66 within 0.05,
    // then m=50 has 64, |64-66|=2 > 0.05 → lastChangeAt = m=50.
    // unchangedMinutes ≈ (now - (loop_time - 50*60_000)) ≈ 50 min,
    // 50 < 60 → not a stall.
    const samples: UsageSample[] = [];
    for (let m = 44; m <= 55; m += 1) {
      const pct = m <= 49 ? 66 : 64;
      samples.push(sample(m, pct, 24));
    }
    const result = usageStall(samples, now(), 60);
    expect(result.stalled).toBe(false);
    expect(result.unchangedMinutes).toBeGreaterThanOrEqual(48);
    expect(result.unchangedMinutes).toBeLessThanOrEqual(52);
  });

  it('handles unsorted input and invalid timestamps', () => {
    const samples: UsageSample[] = [
      sample(60, 50, 10),
      { at: 'not-a-date', usedPct: 70, workersRunning: 5 },
      sample(20, 48, 8),
      70 as unknown as UsageSample,
      sample(40, 49, 12),
    ];
    const result = usageStall(samples, now(), 60);
    expect(result.stalled).toBe(false);
    expect(result.usedPct).toBe(48);
  });

  it('0.04 jitter counts as unchanged', () => {
    const samples: UsageSample[] = [];
    for (let m = 0; m <= 60; m += 1) {
      samples.push(sample(m, 0.5 + (m % 2 === 0 ? 0 : 0.004), 5));
    }
    const result = usageStall(samples, now(), 60);
    expect(result.stalled).toBe(true);
    expect(result.unchangedMinutes).toBe(60);
  });
});
