import { describe, expect, it } from 'vitest';
import { describeJob } from '../../../../core/fleet/job-tail-words.js';
import type { FleetJobDetailV1 } from './worker-log-model.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const running: FleetJobDetailV1 = { schema: 'fleet.job.v1', state: 'running', lane: 'devin' };
const text = (d: FleetJobDetailV1) => describeJob(d, now).text;

describe('describeJob (shared with phm job tail)', () => {
  it('explains an empty Devin log with its elapsed time', () => {
    expect(text({ ...running, launchedAt: '2026-10-31T11:18:00Z', log: { source: 'live', bytes: 0 } }))
      .toBe('Devin writes its log when the job ends (running 42 min). Watch the PR link above instead.');
  });
  it('omits the age for missing or invalid launch times', () => {
    for (const launchedAt of [null, 'invalid']) {
      expect(text({ ...running, launchedAt, log: { source: 'missing' } }))
        .toBe('Devin writes its log when the job ends. Watch the PR link above instead.');
    }
    expect(text(running)).toBe('Devin writes its log when the job ends. Watch the PR link above instead.');
  });
  it('distinguishes an open empty log from a missing one', () => {
    expect(text({ ...running, lane: 'codex', log: { source: 'live', bytes: 0 } })).toBe('Log is open but empty so far.');
    expect(text({ ...running, lane: 'codex', log: { source: 'missing', bytes: 0 } })).toBe('No log yet.');
    expect(describeJob({ ...running, lane: 'codex', log: null }, now)).toEqual({ status: 'no-log', showLog: false, text: 'No log yet.' });
  });
  it.each(['published', 'archived'] as const)('reports a missing log for a %s job with its result', state => {
    const result = state === 'published' ? 'published, no PR link recorded' : 'ended without publishing';
    expect(text({ ...running, state, log: { source: 'missing' } })).toBe(`This job ended without a log. Result: ${result}.`);
    expect(describeJob({ ...running, state, log: null }, now).status).toBe('finished');
  });
  it('names the result and PR of a finished job that kept its log', () => {
    const done = describeJob({ ...running, job: 'RQ-DONE', state: 'published', publish: { prUrl: 'https://github.com/example/repo/pull/7' }, log: { source: 'archived', tail: ['ok'] } }, now);
    expect(done).toEqual({ status: 'finished', showLog: true, text: 'Job RQ-DONE finished. Result: published https://github.com/example/repo/pull/7.' });
  });
  it('calls a job with no evidence at all unknown', () => {
    expect(describeJob({ job: 'RQ-NOPE', state: 'unknown', log: { source: 'missing' }, sources: { launch: 'missing', log: 'missing' } }, now))
      .toEqual({ status: 'unknown', showLog: false, text: 'Job RQ-NOPE is unknown here: no launch, log or result is recorded on this machine.' });
  });
  it('leaves populated logs to the log pane', () => {
    expect(describeJob({ ...running, log: { source: 'live', bytes: 1, tail: ['x'] } }, now)).toEqual({ status: 'live', showLog: true, text: null });
    expect(describeJob({ ...running, lane: 'codex', log: { source: 'live' } }, now).showLog).toBe(true);
  });
});
