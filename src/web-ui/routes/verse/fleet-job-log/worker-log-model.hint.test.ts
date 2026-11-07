import { describe, expect, it } from 'vitest';
import { logHint, type FleetJobDetailV1 } from './worker-log-model.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const running: FleetJobDetailV1 = { schema: 'fleet.job.v1', state: 'running', lane: 'devin' };

describe('logHint', () => {
  it('explains an empty Devin log with its elapsed time', () => {
    expect(logHint({ ...running, launchedAt: '2026-10-31T11:18:00Z', log: { source: 'live', bytes: 0 } }, now))
      .toBe('Devin writes its log when the job ends (running 42 min). Watch the PR link above instead.');
  });
  it('omits the age for missing or invalid launch times', () => {
    for (const launchedAt of [null, 'invalid']) {
      expect(logHint({ ...running, launchedAt, log: { source: 'missing' } }, now))
        .toBe('Devin writes its log when the job ends. Watch the PR link above instead.');
    }
    expect(logHint(running, now)).toBe('Devin writes its log when the job ends. Watch the PR link above instead.');
  });
  it('distinguishes an open empty log from a missing one', () => {
    expect(logHint({ ...running, lane: 'codex', log: { source: 'live', bytes: 0 } }, now)).toBe('Log is open but empty so far.');
    expect(logHint({ ...running, lane: 'codex', log: { source: 'missing', bytes: 0 } }, now)).toBeNull();
    expect(logHint({ ...running, lane: 'codex', log: null }, now)).toBeNull();
  });
  it.each(['published', 'archived'] as const)('reports a missing log for a %s job', state => {
    expect(logHint({ ...running, state, log: { source: 'missing' } }, now)).toBe('This job ended without a log.');
    expect(logHint({ ...running, state, log: null }, now)).toBe('This job ended without a log.');
  });
  it('leaves populated and unspecified logs to the existing rendering', () => {
    expect(logHint({ ...running, log: { source: 'live', bytes: 1, tail: ['x'] } }, now)).toBeNull();
    expect(logHint({ ...running, lane: 'codex', log: { source: 'live' } }, now)).toBeNull();
    expect(logHint({ ...running, state: 'unknown', log: null }, now)).toBeNull();
  });
});
