import { describe, expect, it } from 'vitest';
import { SELF_TICK_LAST_COMMAND, SELF_TICK_SCHEDULE_COMMAND, selfTickNeedsYou } from './self-tick-needs-you.js';
import type { SelfTickLastView } from './self-tick-query.js';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const at = (ageSeconds: number) => new Date(NOW - ageSeconds * 1_000).toISOString();
const ok = (overrides: Partial<Extract<SelfTickLastView, { state: 'ok' }>> = {}): SelfTickLastView => ({
  state: 'ok', at: at(60), mode: 'apply', ranState: 'ran', ageSeconds: 60, failedSteps: [], ...overrides,
});

describe('self-tick needs you', () => {
  it('shows "never run" when no record exists', () => {
    expect(selfTickNeedsYou(null, NOW)).toMatchObject([{
      id: 'self-tick-never-run', severity: 'urgent', target: 'fleet',
      title: 'Self-tick has never run',
      open: { kind: 'terminal', command: SELF_TICK_SCHEDULE_COMMAND },
    }]);
  });

  it('shows an unreadable record', () => {
    expect(selfTickNeedsYou({ state: 'unreadable' }, NOW)).toMatchObject([{
      id: 'self-tick-unreadable',
      title: 'Self-tick record is unreadable',
      open: { kind: 'terminal', command: SELF_TICK_LAST_COMMAND },
    }]);
  });

  it('shows a stopped timer with its age once the record outlives two max intervals', () => {
    expect(selfTickNeedsYou(ok({ ageSeconds: 7_300, at: at(7_300) }), NOW)).toMatchObject([{
      id: 'self-tick-stale', severity: 'urgent',
      title: 'Self-tick last ran 2 h ago',
      open: { kind: 'terminal', command: SELF_TICK_SCHEDULE_COMMAND },
    }]);
    // Exactly at the line is still fresh — the rule is strictly older than two intervals.
    expect(selfTickNeedsYou(ok({ ageSeconds: 7_200, at: at(7_200) }), NOW)).toEqual([]);
  });

  it('ages a borderline record against the drawer clock', () => {
    const borderline = ok({ ageSeconds: 7_190, at: at(7_190) });
    expect(selfTickNeedsYou(borderline, NOW)).toEqual([]);
    expect(selfTickNeedsYou(borderline, NOW + 20_000)[0]?.id).toBe('self-tick-stale');
  });

  it('names the failed steps', () => {
    expect(selfTickNeedsYou(ok({ failedSteps: ['lane-autohold', 'planner-tick'] }), NOW)).toMatchObject([{
      id: 'self-tick-failed', severity: 'urgent',
      title: 'Self-tick step failed: lane-autohold, planner-tick',
      open: { kind: 'terminal', command: SELF_TICK_LAST_COMMAND },
    }]);
  });

  it('prefers the stopped timer over a stale record that also failed', () => {
    expect(selfTickNeedsYou(ok({ ageSeconds: 8_000, at: at(8_000), failedSteps: ['planner-tick'] }), NOW)[0]?.id)
      .toBe('self-tick-stale');
  });

  it('shows nothing for a fresh pass with no failures, including a busy skip', () => {
    expect(selfTickNeedsYou(ok(), NOW)).toEqual([]);
    expect(selfTickNeedsYou(ok({ ranState: 'busy' }), NOW)).toEqual([]);
    expect(selfTickNeedsYou(ok({ mode: 'dry-run' }), NOW)).toEqual([]);
  });

  it('appends (dry run) to a dry-run row without hiding it', () => {
    expect(selfTickNeedsYou(ok({ mode: 'dry-run', failedSteps: ['planner-tick'] }), NOW)[0]?.title)
      .toBe('Self-tick step failed: planner-tick (dry run)');
    expect(selfTickNeedsYou(ok({ mode: 'dry-run', ageSeconds: 8_000, at: at(8_000) }), NOW)[0]?.title)
      .toBe('Self-tick last ran 2 h ago (dry run)');
  });

  it('shows nothing when there is no read to judge', () => {
    expect(selfTickNeedsYou(undefined, NOW)).toEqual([]);
  });
});
