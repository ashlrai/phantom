import { describe, expect, it } from 'vitest';
import { liveAgeSeconds, LIVE_AGE_TICK_MS } from './live-age.js';

describe('LIVE_AGE_TICK_MS', () => {
  it('fires once per second', () => {
    expect(LIVE_AGE_TICK_MS).toBe(1000);
  });
});

describe('liveAgeSeconds', () => {
  // ---------- null inputs ----------

  it('returns null when ageSeconds is null', () => {
    const GEN = '2026-10-31T12:00:00Z';
    const NOW = Date.parse(GEN) + 5_000;
    expect(liveAgeSeconds(null, GEN, NOW)).toBeNull();
  });

  it('returns null when generatedAt does not parse', () => {
    const NOW = Date.parse('2026-10-31T12:00:05Z');
    expect(liveAgeSeconds(30, 'not-a-date', NOW)).toBeNull();
    expect(liveAgeSeconds(30, '', NOW)).toBeNull();
    expect(liveAgeSeconds(30, '2026-13-45T99:99:99Z', NOW)).toBeNull();
  });

  // ---------- happy path: linear tick ----------

  it('adds 30 s when now is 30 s later', () => {
    const GEN = '2026-10-31T12:00:00Z';
    const NOW = Date.parse(GEN) + 30_000;
    expect(liveAgeSeconds(60, GEN, NOW)).toBe(90);
  });

  it('adds 0 s when now equals generatedAt', () => {
    const GEN = '2026-10-31T12:00:00Z';
    const NOW = Date.parse(GEN);
    expect(liveAgeSeconds(45, GEN, NOW)).toBe(45);
  });

  // ---------- clock that runs backwards ----------

  it('caps at original ageSeconds when now < generatedAt', () => {
    const GEN = '2026-10-31T12:00:00Z';
    const NOW = Date.parse(GEN) - 120_000;
    expect(liveAgeSeconds(60, GEN, NOW)).toBe(60);
  });

  // ---------- staleness cap ----------

  it('caps at ageSeconds + 600 when 20 minutes later', () => {
    const GEN = '2026-10-31T12:00:00Z';
    const NOW = Date.parse(GEN) + 20 * 60_000;
    expect(liveAgeSeconds(120, GEN, NOW)).toBe(720);   // 120 + 600
  });

  it('does not cap when elapsed < 600 s', () => {
    const GEN = '2026-10-31T12:00:00Z';
    const NOW = Date.parse(GEN) + 300_000;
    expect(liveAgeSeconds(100, GEN, NOW)).toBe(400);
  });

  // ---------- fractional elapsed ----------

  it('floors fractional elapsed to whole seconds', () => {
    const GEN = '2026-10-31T12:00:00Z';
    const NOW = Date.parse(GEN) + 45_500;   // 45.5 s → 45 s
    expect(liveAgeSeconds(60, GEN, NOW)).toBe(105);
  });

  it('treats sub-second elapsed as 0', () => {
    const GEN = '2026-10-31T12:00:00Z';
    const NOW = Date.parse(GEN) + 999;
    expect(liveAgeSeconds(100, GEN, NOW)).toBe(100);
  });
});
