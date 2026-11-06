import { expect, it } from 'vitest';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { hubTiles, snapshotAge } from './fleet-hub-model.js';

const registered = [
  { id: 'fleet-usage', title: 'Usage' }, { id: 'fleet-host', title: 'Host' },
  { id: 'fleet-timeline', title: 'Timeline' }, { id: 'fleet-dispatch', title: 'Dispatch' },
  { id: 'fleet-releases', title: 'Releases' }, { id: 'fleet-decisions', title: 'Decisions' },
];
const ids = registered.map(({ id }) => id);

const fixture: FleetRuns = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { runsDir: 'degraded', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
  lanes: [{ lane: 'codex', running: 1, target: 2, queued: 3, held: true, heldReason: 'Budget hold', tokensLastHour: null, merged24h: null, mergeRate24h: null }],
  workers: Array.from({ length: 13 }, (_, i) => ({ job: `job-${i}`, repo: 'example/repo', lane: 'codex', tier: 'frontier', ageSeconds: i })),
  leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: 2, items: [{ repo: 'example/repo', number: 12, title: 'Fleet view' }, { repo: 'unknown', number: 13, title: 'No owner' }] }, events: [], codexPersonal: null, inbox: [], drop: null, claimed: [],
};

const count = (runs: FleetRuns | null, id: string) => hubTiles(runs, registered).find((tile) => tile.id === id)?.count;

it('reads usage, host, timeline, dispatch, releases and decisions from the snapshot', () => {
  const runs: FleetRuns = {
    ...fixture, diskFreeGb: 41.26, memFreePct: 12,
    codexPersonal: { usedPct: 93, resetsAt: null, asOf: null },
    events: [{ at: '1', kind: 'tick', text: 'a' }, { at: '2', kind: 'tick', text: 'b' }],
    publishesLastHour: [{ job: 'job-1', lane: 'codex', url: 'https://example.test/pr/1', at: '1' }],
    drop: { pending: [{ lane: 'codex', file: 'a.md' }, { lane: 'codex', file: 'b.md' }, { lane: 'codex', file: 'c.md' }], done: 4 },
  };
  expect(count(runs, 'fleet-usage')).toBe('93% personal');
  expect(count(runs, 'fleet-host')).toBe('41.3 GB free · 12% mem');
  expect(count(runs, 'fleet-timeline')).toBe('2 events');
  expect(count(runs, 'fleet-dispatch')).toBe('all held');
  expect(count(runs, 'fleet-releases')).toBe('1 publishes/h');
  expect(count(runs, 'fleet-decisions')).toBe('3 in drop');
});

it('rounds the personal usage percent and drops the mem suffix when unknown', () => {
  const runs: FleetRuns = {
    ...fixture, diskFreeGb: 41.26,
    codexPersonal: { usedPct: 92.6, resetsAt: '2026-11-01T00:00:00Z', asOf: '2026-10-31T11:59:00Z' },
  };
  expect(count(runs, 'fleet-usage')).toBe('93% personal');
  expect(count(runs, 'fleet-host')).toBe('41.3 GB free');
  expect(count({ ...runs, codexPersonal: { usedPct: null, resetsAt: null, asOf: null } }, 'fleet-usage')).toBe('—');
});

it('sums free slots across lanes that are not held', () => {
  const lane = { queued: 0, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null };
  const runs: FleetRuns = {
    ...fixture,
    lanes: [
      { ...lane, lane: 'a', running: 3, target: 10, held: false },
      { ...lane, lane: 'b', running: 0, target: 6, held: true },
      { ...lane, lane: 'c', running: 4, target: 2, held: false },
    ],
  };
  expect(count(runs, 'fleet-dispatch')).toBe('7 free');
});

it('shows "—" when snapshot inputs are missing or empty', () => {
  const empty: FleetRuns = { ...fixture, lanes: [] };
  for (const id of ids) expect(count(empty, id), id).toBe('—');
  expect(count({ ...empty, drop: { pending: [], done: 9 } }, 'fleet-decisions')).toBe('—');
  expect(hubTiles(null, registered).every((tile) => tile.count === '—')).toBe(true);
});

it('describes the snapshot age', () => {
  const at = '2026-10-31T12:00:00Z';
  expect(snapshotAge(at, Date.parse('2026-10-31T12:00:05Z'))).toBe('read just now');
  expect(snapshotAge(at, Date.parse('2026-10-31T12:00:40Z'))).toBe('read 40s ago');
  expect(snapshotAge(at, Date.parse('2026-10-31T12:02:00Z'))).toBe('read 2 minutes ago');
  expect(snapshotAge(at, Date.parse('2026-10-31T11:59:59Z'))).toBe('read just now');
  expect(snapshotAge(null, Date.parse('2026-10-31T12:00:05Z'))).toBe('reading not timed');
  expect(snapshotAge('not a date', Date.parse('2026-10-31T12:00:05Z'))).toBe('reading not timed');
});
