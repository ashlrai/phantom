import { expect, it } from 'vitest';
import { fleetRunsFixture } from '../fleet/fleet-runs-fixtures.test-support.js';
import { paletteWorkers } from './palette-workers.js';

const runs = () => ({ ...fleetRunsFixture(), claudeLane: null });

it('joins publishes by job, filters invalid ids and orders oldest first without mutating the snapshot', () => {
  const snapshot = runs();
  snapshot.workers = [
    { job: 'RQ-PHX-YOUNG', repo: 'phantom', lane: 'codex', tier: 'mid', ageSeconds: 60 },
    { job: '../bad', repo: 'phantom', lane: 'codex', tier: 'mid', ageSeconds: 999 },
    { job: 'RQ-FAKE-JOB1', repo: 'phantom', lane: 'codex', tier: 'mid', ageSeconds: 720 },
    { job: 'RQ-PHX-UNKNOWN', repo: 'phantom', lane: 'codex', tier: 'mid', ageSeconds: null },
  ];
  expect(paletteWorkers(snapshot).map(w => [w.job, w.prUrl])).toEqual([
    ['RQ-FAKE-JOB1', 'https://github.com/example/repo/pull/1'], ['RQ-PHX-YOUNG', null], ['RQ-PHX-UNKNOWN', null],
  ]);
  expect(snapshot.workers[0]?.job).toBe('RQ-PHX-YOUNG');
});

it.each(['javascript:alert(1)', 'data:text/html,bad', 'file:///tmp/a', 'not a url', null])('rejects unsafe PR URL %s', url => {
  const snapshot = runs();
  snapshot.publishesLastHour[0]!.url = url;
  expect(paletteWorkers(snapshot)[0]?.prUrl).toBeNull();
});

it('handles absent snapshots', () => {
  expect(paletteWorkers(null)).toEqual([]);
  expect(paletteWorkers(undefined)).toEqual([]);
});

it('uses the latest publish for a job and preserves the shared HTTP URL guard', () => {
  const snapshot = runs();
  snapshot.publishesLastHour.unshift({ job: 'RQ-FAKE-JOB1', lane: null, url: 'http://example.com/pull/2', at: '2026-10-31T06:00:00Z' });
  expect(paletteWorkers(snapshot)[0]?.prUrl).toBe('http://example.com/pull/2');
});
