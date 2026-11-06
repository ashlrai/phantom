import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseResetWindows } from '../src/core/fabric/reset-windows.js';

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/reset-windows/${name}.txt`, import.meta.url), 'utf8');
const now = new Date('2026-10-26T18:00:00Z');

describe('pool reset schedules', () => {
  it('parses weekly deadlines with explicit timezone conversion', () => {
    const schedule = parseResetWindows(fixture('weekly'));
    expect(schedule.windows).toEqual([
      { pool: 'codex-personal', window: 'weekly', resetAt: '2026-10-30T23:00:00.000Z' },
      { pool: 'claude-work', window: 'weekly', resetAt: '2026-11-01T00:00:00.000Z' },
    ]);
    expect(schedule.hoursToReset('codex-personal', now)).toBe(101);
  });

  it('uses the last daily reading and preserves fractional hours', () => {
    const schedule = parseResetWindows(fixture('daily').replaceAll('\n', '\r\n'));
    expect(schedule.windows).toHaveLength(2);
    expect(schedule.hoursToReset('codex-personal', now.getTime())).toBe(24.5);
    expect(schedule.hoursToReset('claude-work', now)).toBe(5);
  });

  it('returns unknown for missing readings, empty logs and unknown pools', () => {
    for (const log of ['', fixture('missing')]) {
      const schedule = parseResetWindows(log);
      expect(schedule.windows).toEqual([]);
      expect(schedule.hoursToReset('codex-personal', now)).toBeNull();
    }
    expect(parseResetWindows(fixture('weekly')).hoursToReset('absent', now)).toBeNull();
  });

  it('retains both windows and selects the next known deadline without rolling elapsed windows', () => {
    const schedule = parseResetWindows(fixture('weekly') + fixture('daily'));
    expect(schedule.windows).toHaveLength(4);
    expect(schedule.hoursToReset('codex-personal', now)).toBe(24.5);
    expect(schedule.hoursToReset('codex-personal', new Date('2026-10-27T18:30:00Z'))).toBe(0);
    expect(schedule.hoursToReset('codex-personal', new Date('2026-10-28T18:00:00Z'))).toBe(53);
    expect(schedule.hoursToReset('codex-personal', new Date('2026-11-02T00:00:00Z'))).toBeNull();
  });

  it.each([
    '{broken', 'null', '[]',
    'pool=x window=monthly resetAt=2026-10-27T00:00:00Z',
    'pool=x window=daily resetAt=2026-10-27T00:00:00',
    'pool=x window=daily resetAt=2026-02-30T00:00:00Z',
    'pool=x window=daily resetAt=2026-13-01T00:00:00Z',
    'pool=x window=daily resetAt=2026-10-27T25:00:00Z',
    'pool=x pool=y window=daily resetAt=2026-10-27T00:00:00Z',
    '{"pool":"","window":"daily","resetAt":"2026-10-27T00:00:00Z"}',
  ])('ignores malformed reading %s without erasing valid evidence', (line) => {
    const schedule = parseResetWindows(fixture('daily') + line);
    expect(schedule.windows).toHaveLength(2);
  });

  it('rejects invalid clocks and keeps independent schedules immutable', () => {
    const schedule = parseResetWindows(fixture('weekly'));
    expect(schedule.hoursToReset('codex-personal', new Date(NaN))).toBeNull();
    expect(schedule.hoursToReset('codex-personal', Infinity)).toBeNull();
    expect(Object.isFrozen(schedule.windows[0])).toBe(true);
    expect(Object.isFrozen(schedule.windows)).toBe(true);
    expect(parseResetWindows('').windows).toEqual([]);
    expect(schedule.windows).toHaveLength(2);
  });
});
