import { describe, expect, it } from 'vitest';
import { readLeaderPasses } from './leader-passes-model.js';

const now = Date.parse('2026-10-31T00:00:00Z');
const pass = (ageSeconds: number | null, nowMs = now) => readLeaderPasses({
  generatedAt: new Date(now).toISOString(), leaders: [{ label: 'leader', ageSeconds }],
}, nowMs).passes[0]!;

describe('leader pass due state', () => {
  it('reports the next due time and overdue severity', () => {
    expect(pass(6 * 60)).toMatchObject({ dueText: 'next pass in ~9 min', tone: 'ok' });
    expect(pass(48 * 60)).toMatchObject({ dueText: 'pass overdue by 33 min', tone: 'danger' });
    expect(pass(20 * 60)).toMatchObject({ dueText: 'pass overdue by 5 min', tone: 'warning' });
    expect(pass(null)).toMatchObject({ dueText: 'no pass recorded', eta: { kind: 'unknown' } });
  });

  it('advances the due state with the snapshot and respects the danger boundary', () => {
    expect(pass(14 * 60, now + 6 * 60_000)).toMatchObject({ tone: 'warning', dueText: 'pass overdue by 5 min' });
    expect(pass(45 * 60).tone).toBe('warning');
    expect(pass(45 * 60 + 1).tone).toBe('danger');
    expect(pass(16 * 60).eta.kind).toBe('due-in');
  });
});
