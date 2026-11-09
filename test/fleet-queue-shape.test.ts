import { expect, it } from 'vitest';
import type { FleetLaneQueueRow } from '../src/core/fleet/lane-console.js';
import { queueShape, type QueueShapeTargetRow } from '../src/core/fleet/queue-shape.js';

const row = (pool: string, repo?: string, status = 'READY'): FleetLaneQueueRow =>
  ({ id: null, status, pool, repo });
const rows = (pool: string, count: number, repo?: string, status = 'READY'): FleetLaneQueueRow[] =>
  Array.from({ length: count }, () => row(pool, repo, status));
const target = (lane: string, slots: number, held = false): QueueShapeTargetRow =>
  ({ lane, target: slots, held });

it('flags lanes deeper than 3x target and reports ratio and totals', () => {
  const report = queueShape(
    [...rows('devin', 31, 'ashlrai/stack'), ...rows('codex', 30, 'ashlrai/phantom')],
    [target('devin', 10), target('codex', 10)],
  );
  expect(report).toMatchObject({ v: 1, totalReady: 61, totalTarget: 20, overDeep: ['devin'] });
  const devin = report.lanes.find(lane => lane.lane === 'devin')!;
  expect(devin).toMatchObject({ ready: 31, target: 10, ratio: 3.1, overDeep: true, held: false });
  const codex = report.lanes.find(lane => lane.lane === 'codex')!;
  // Exactly 3x is not over the bound — the factor is a strict cutoff.
  expect(codex).toMatchObject({ ready: 30, ratio: 3, overDeep: false });
  expect(report.lanes[0]!.lane).toBe('devin');
});

it('keeps held state and a custom factor; sorts over-deep lanes first then by ready', () => {
  const report = queueShape(
    [...rows('devin', 9), ...rows('codex', 20), ...rows('grok', 10)],
    [target('devin', 5, true), target('codex', 8), target('grok', 4)],
    { overDeepFactor: 2 },
  );
  // devin 9/5=1.8x stays under factor 2; codex 2.5x and grok 2.5x are over,
  // ordered ahead of the held lane even though devin's 9 rows outrank grok's.
  expect(report.overDeep).toEqual(['codex', 'grok']);
  expect(report.lanes.map(lane => lane.lane)).toEqual(['codex', 'grok', 'devin']);
  expect(report.lanes.find(lane => lane.lane === 'devin')!.held).toBe(true);
});

it('flags target 0 lanes that still carry ready rows, with null ratio', () => {
  const report = queueShape(rows('devin', 2, 'ashlrai/stack'), [target('devin', 0), target('idle', 0)]);
  const devin = report.lanes.find(lane => lane.lane === 'devin')!;
  expect(devin).toMatchObject({ ready: 2, target: 0, ratio: null, overDeep: true });
  expect(report.lanes.find(lane => lane.lane === 'idle')!).toMatchObject({ ready: 0, overDeep: false });
  expect(report.totalTarget).toBe(0);
});

it('gives lanes without a target row a null target and ratio and never flags them', () => {
  const report = queueShape(rows('devin', 50), []);
  expect(report.lanes).toEqual([
    expect.objectContaining({ lane: 'devin', ready: 50, target: null, ratio: null, overDeep: false, held: false }),
  ]);
  expect(report.totalTarget).toBe(0);
});

it('ranks top repos by ready share; missing repo counts as (none) and shares sum to 1', () => {
  const report = queueShape(
    [...rows('devin', 5, 'ashlrai/stack'), ...rows('devin', 3, 'ashlrai/phantom'), row('devin'), row('devin')],
    [target('devin', 10)],
  );
  const lane = report.lanes[0]!;
  expect(lane.topRepos).toEqual([
    { repo: 'ashlrai/stack', ready: 5, share: 0.5 },
    { repo: 'ashlrai/phantom', ready: 3, share: 0.3 },
    { repo: '(none)', ready: 2, share: 0.2 },
  ]);
  expect(lane.topRepos.reduce((sum, repo) => sum + repo.share, 0)).toBeCloseTo(1);
});

it('honours topRepos and never counts non-READY statuses', () => {
  const report = queueShape(
    [
      ...rows('devin', 2, 'a/one'), ...rows('devin', 2, 'b/two'), ...rows('devin', 2, 'c/three'),
      ...rows('devin', 4, 'a/one', 'CLAIMED'), ...rows('devin', 3, 'a/one', 'RUNNING'),
    ],
    [target('devin', 5)],
    { topRepos: 2 },
  );
  const lane = report.lanes[0]!;
  expect(lane.ready).toBe(6);
  expect(lane.topRepos.map(repo => repo.repo)).toEqual(['a/one', 'b/two']);
  expect(lane.topRepos.every(repo => repo.ready === 2)).toBe(true);
});

it('ages each lane by its oldest READY row; missing, bad or future times are untimed, never guessed', () => {
  const now = Date.parse('2026-11-09T12:00:00Z');
  const at = (time?: string, pool = 'devin', status = 'READY'): FleetLaneQueueRow => ({ id: null, status, pool, at: time });
  const report = queueShape(
    [
      at('2026-11-09T09:00:00Z'), at('2026-11-09T11:30:00Z'), at(), at('not a date'), at('2026-11-09T13:00:00Z'),
      at('2026-11-01T00:00:00Z', 'devin', 'CLAIMED'),
      at('2026-11-01T00:00:00Z', 'codex', 'RUNNING'),
    ],
    [target('devin', 10), target('quiet', 3)],
    { now },
  );
  expect(report.lanes.find(lane => lane.lane === 'devin')).toMatchObject({
    ready: 5, oldestReadyAgeSeconds: 10800, untimedReady: 3,
  });
  expect(report.lanes.find(lane => lane.lane === 'quiet')).toMatchObject({
    ready: 0, oldestReadyAgeSeconds: null, untimedReady: 0,
  });
  // Without a clock no age can be measured; every READY row is untimed.
  const clockless = queueShape([at('2026-11-09T09:00:00Z')], [target('devin', 10)]);
  expect(clockless.lanes[0]).toMatchObject({ oldestReadyAgeSeconds: null, untimedReady: 1 });
});

it('includes target-only lanes at ready 0 and drops malformed rows', () => {
  const report = queueShape(
    [row('devin'), { id: null, status: 'READY', pool: '' }, { id: null, status: 'READY', pool: undefined as unknown as string }],
    [target('devin', 10), target('quiet', 3)],
  );
  expect(report.lanes.map(lane => lane.lane).sort()).toEqual(['devin', 'quiet']);
  expect(report.lanes.find(lane => lane.lane === 'quiet')!).toMatchObject({ ready: 0, target: 3, ratio: 0, overDeep: false });
  expect(report.totalReady).toBe(1);
  expect(queueShape([], []).lanes).toEqual([]);
});
