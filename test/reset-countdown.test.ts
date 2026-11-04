import { describe, expect, it } from 'vitest';
import { resetCountdown } from '../src/core/fleet/reset-countdown.js';

const NOW = Date.parse('2026-11-03T12:00:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (ms: number) => new Date(NOW + ms).toISOString();

describe('resetCountdown', () => {
  it('reports unknown for missing, empty or unparseable resetAt', () => {
    expect(resetCountdown(null, NOW)).toBe('reset unknown');
    expect(resetCountdown(undefined, NOW)).toBe('reset unknown');
    expect(resetCountdown('', NOW)).toBe('reset unknown');
    expect(resetCountdown('not-a-date', NOW)).toBe('reset unknown');
  });

  it('reports passed when resetAt is at or before now', () => {
    expect(resetCountdown(at(0), NOW)).toBe('reset passed');
    expect(resetCountdown(at(-MIN), NOW)).toBe('reset passed');
  });

  it('rounds sub-minute remainders up to a minimum of 1m', () => {
    expect(resetCountdown(at(30_000), NOW)).toBe('resets in 1m');
    expect(resetCountdown(at(1), NOW)).toBe('resets in 1m');
  });

  it('shows whole minutes under one hour', () => {
    expect(resetCountdown(at(42 * MIN), NOW)).toBe('resets in 42m');
    expect(resetCountdown(at(59 * MIN), NOW)).toBe('resets in 59m');
    expect(resetCountdown(at(59 * MIN + 30_000), NOW)).toBe('resets in 1h');
  });

  it('shows hours and minutes under 48 hours, dropping a zero minute part', () => {
    expect(resetCountdown(at(HOUR), NOW)).toBe('resets in 1h');
    expect(resetCountdown(at(3 * HOUR), NOW)).toBe('resets in 3h');
    expect(resetCountdown(at(3 * HOUR + 12 * MIN), NOW)).toBe('resets in 3h 12m');
    expect(resetCountdown(at(47 * HOUR + 59 * MIN), NOW)).toBe('resets in 47h 59m');
  });

  it('shows days and hours from 48 hours, dropping a zero hour part', () => {
    expect(resetCountdown(at(48 * HOUR), NOW)).toBe('resets in 2d');
    expect(resetCountdown(at(4 * 24 * HOUR + 6 * HOUR), NOW)).toBe('resets in 4d 6h');
    expect(resetCountdown(at(4 * 24 * HOUR), NOW)).toBe('resets in 4d');
  });
});
