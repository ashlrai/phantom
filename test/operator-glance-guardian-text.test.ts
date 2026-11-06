import { describe, expect, it } from 'vitest';
import type { GuardianGlanceRow } from '../src/core/fleet/guardian-glance.js';
import { formatOperatorGlance, isOperatorGlance, type OperatorGlance } from '../src/core/fleet/operator-glance.js';

const NOW = Date.parse('2026-11-03T12:00:00.000Z');

function row(repo: string, over: Partial<GuardianGlanceRow> = {}): GuardianGlanceRow {
  return { repo, state: 'green', lastPassAt: null, ageMinutes: 5, openFixes: 0, stale: false, ...over };
}

function glance(over: Partial<OperatorGlance> = {}): OperatorGlance {
  return {
    v: 1, at: '2026-11-03T12:00:00.000Z', running: 2, target: 4, usagePct: 50, resetsAt: null,
    mergesToday: 3, main: 'up', incidents: [], ...over,
  };
}

const mainLine = (g: OperatorGlance): string => formatOperatorGlance(g, NOW).split('\n')[3] ?? '';

describe('operator glance guardian text', () => {
  it('names a red repo with plural fixes', () => {
    expect(mainLine(glance({ guardian: [row('phantom', { state: 'red', openFixes: 2 }), row('hub')] })))
      .toBe('Main red: phantom (2 fixes).');
  });

  it('uses singular for one fix and drops parentheses for zero', () => {
    expect(mainLine(glance({ guardian: [row('a', { state: 'red', openFixes: 1 }), row('b', { state: 'red' })] })))
      .toBe('Main red: a (1 fix), b.');
  });

  it('lists three red repos then +N more', () => {
    const guardian = ['a', 'b', 'c', 'd', 'e'].map((r) => row(r, { state: 'red' }));
    expect(mainLine(glance({ guardian }))).toBe('Main red: a, b, c +2 more.');
  });

  it('reports stale guardian when nothing is red', () => {
    expect(mainLine(glance({ main: 'down', guardian: [row('a'), row('b', { stale: true }), row('c', { state: 'unknown', stale: true })] })))
      .toBe('Main green; guardian stale on b, c.');
  });

  it('reports healthy with a repo count', () => {
    expect(mainLine(glance({ main: 'unknown', guardian: [row('a'), row('b')] }))).toBe('Main is healthy (2 repos).');
  });

  it('keeps legacy lines when guardian is absent or empty', () => {
    expect(mainLine(glance({ main: 'up' }))).toBe('Main is healthy.');
    expect(mainLine(glance({ main: 'down' }))).toBe('Main needs you.');
    expect(mainLine(glance({ main: 'unknown' }))).toBe('Main health unknown.');
    expect(mainLine(glance({ main: 'down', guardian: [] }))).toBe('Main needs you.');
  });

  it('cleans control characters and clips long names', () => {
    const long = 'x'.repeat(60);
    const out = mainLine(glance({ guardian: [row('bad\u0007\nrepo', { state: 'red' }), row(long, { state: 'red' })] }));
    expect(out).toBe(`Main red: badrepo, ${'x'.repeat(40)}.`);
  });

  it('validates guardian rows in isOperatorGlance', () => {
    expect(isOperatorGlance(glance())).toBe(true);
    expect(isOperatorGlance(glance({ guardian: [row('a'), row('b', { ageMinutes: null })] }))).toBe(true);
    expect(isOperatorGlance(glance({ guardian: [row('a', { state: 'purple' as 'red' })] }))).toBe(false);
    expect(isOperatorGlance(glance({ guardian: [row('a', { openFixes: -1 })] }))).toBe(false);
    expect(isOperatorGlance(glance({ guardian: [row('a', { openFixes: 1.5 })] }))).toBe(false);
    expect(isOperatorGlance(glance({ guardian: [row('a', { stale: 'no' as unknown as boolean })] }))).toBe(false);
    expect(isOperatorGlance(glance({ guardian: 'x' as unknown as GuardianGlanceRow[] }))).toBe(false);
  });
});
