import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';

// The API's file readers remain real; avoid querying this machine's launchd service.
vi.mock('../src/core/fleet/health-age.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/fleet/health-age.js')>(),
  readGuardianServiceHealth: async () => ({ state: 'unknown', lastExitCode: null, diagnostic: 'fixture' }),
}));
import { fleetStatusApi } from '../src/core/fleet/status-api.js';

const now = Date.parse('2026-01-01T12:00:00Z');
let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

async function fixture(lastTick = now, paused = false, admission?: Record<string, unknown>) {
  root = await mkdtemp(join(tmpdir(), 'headroom-api-'));
  await mkdir(join(root, 'queue'));
  await mkdir(join(root, 'metrics'));
  await writeFile(join(root, 'queue/status.json'), JSON.stringify({
    last_tick: new Date(lastTick).toISOString(), paused, mem_free_pct: 50, admission,
    lanes: {
      held: { running: 1, target: 5, effective_target: 4, queued: 0, held: true },
      shed: { running: 1, target: 5, effective_target: 3, queued: 0, held: false },
      over: { running: 4, target: 3, effective_target: 2, queued: 0, held: false },
      absent: { running: 1, target: 4, queued: 0, held: false },
      nullable: { running: 2, target: 5, effective_target: null, queued: 0, held: false },
      capped: { running: 1, target: 3, effective_target: 9, queued: 0, held: false },
    },
    rollup_24h: { by_lane: { shed: { merged: 2 } } },
  }));
  await writeFile(join(root, 'queue/ready.tsv'), 'job-a\tphantom\tshed\twork\tfixture\n');
  await writeFile(join(root, 'queue/claimed.tsv'), 'job-b\tshed\twork\t12:00\t1767268800\n');
  await writeFile(join(root, 'metrics/jobs.jsonl'), '');
  return fleetStatusApi(root, () => now);
}

test('preserves headroom alongside sibling capacity and current API evidence', async () => {
  const report = await fixture();
  expect(report).toMatchObject({
    schema: 'fleet.status-api.v1', fresh: true, paused: false,
    generatedAt: '2026-01-01T12:00:00.000Z', observedAt: '2026-01-01T12:00:00.000Z',
    sources: { status: 'healthy', claimed: 'healthy', queue: 'healthy', metrics: 'healthy' },
    queue: { ready: 1, parked: 0 }, sessionsTruncated: false, lanesTruncated: false,
    sessions: [{ job: 'job-b', lane: 'shed', tier: 'work', claimedAt: '2026-01-01T12:00:00.000Z' }],
    publishedLastHour: 0,
    awareness: { schema: 'fleet.awareness.v1' },
    guardian: { name: 'guardian', readOnly: true, age: { status: 'missing file' }, service: { state: 'unknown' } },
  });
  expect(report.lanes).toEqual([
    { lane: 'held', running: 1, target: 5, effectiveTarget: 4, held: true, available: 0, merged24h: null },
    { lane: 'shed', running: 1, target: 5, effectiveTarget: 3, held: false, available: 2, merged24h: 2 },
    { lane: 'over', running: 4, target: 3, effectiveTarget: 2, held: false, available: 0, merged24h: null },
    { lane: 'absent', running: 1, target: 4, effectiveTarget: null, held: false, available: 3, merged24h: null },
    { lane: 'nullable', running: 2, target: 5, effectiveTarget: null, held: false, available: 3, merged24h: null },
    { lane: 'capped', running: 1, target: 3, effectiveTarget: 9, held: false, available: 2, merged24h: null },
  ]);
});

test.each([
  ['stale', now - 60_001, false, false],
  ['future', now + 1, false, false],
  ['paused', now, true, true],
])('%s snapshot does not invent availability', async (_label, tick, paused, fresh) => {
  const report = await fixture(tick, paused);
  expect(report).toMatchObject({ fresh, paused, schema: 'fleet.status-api.v1' });
  expect(report.lanes).toHaveLength(6);
  expect(report.lanes.every(lane => lane.available === null)).toBe(true);
});

test.each([
  ['one shared slot', { cap: 10, running: 9 }, 1],
  ['at fleet cap', { cap: 10, running: 10 }, 0],
  ['over fleet cap', { cap: 10, running: 11 }, 0],
  ['admission stopped below cap', { cap: 10, running: 9, admit: false }, 0],
  ['load gate', { gate_reason: 'load gate active' }, 0],
  ['malformed count', { cap: 10, running: '9' }, 3],
  ['admission from another tick', { ts: new Date(now - 30_000).toISOString(), decision: 'stop' }, 3],
] as const)('%s bounds lane availability consistently in both views', async (_label, admission, expected) => {
  const report = await fixture(now, false, { ts: new Date(now).toISOString(), ...admission });
  for (const lanes of [report.lanes, report.awareness.lanes]) {
    expect(lanes.find(lane => lane.lane === 'absent')?.available).toBe(expected);
    expect(lanes.find(lane => lane.lane === 'shed')?.available).toBe(Math.min(2, expected));
    expect(lanes.find(lane => lane.lane === 'held')?.available).toBe(0);
  }
});
