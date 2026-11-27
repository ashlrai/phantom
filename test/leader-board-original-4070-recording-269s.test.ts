import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { recordLeaderBoard } from '../src/core/fleet/leader-board.js';
import { fleetBoardResponse, readFleetBoard } from '../src/core/fleet/leader-journal.js';

const NOW_MS = Date.parse('2026-11-13T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW_MS - m * 60_000).toISOString();
const row = (status: string, id: string, pool: string, tier: string) =>
  `${status}\t${id}\t${pool}\t${tier}\texample/phantom\tFixture`;
const merge = (job: string, lane: string, ts: string) =>
  JSON.stringify({ job, lane, event: 'outcome', state: 'MERGED', ts });

let root: string;
let queueDir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'leader-board-4070-'));
  queueDir = join(root, 'queue');
  await mkdir(queueDir, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function seed(): Promise<void> {
  await writeFile(join(queueDir, 'ready.tsv'), [
    row('READY', 'RQ-TEST-1', 'devin', 'work'),
    row('READY', 'RQ-TEST-2', 'devin', 'work'),
    row('READY', 'RQ-TEST-3', 'codex', 'fast'),
    row('READY', 'RQ-REBASE-PHANTOM-1234-abc1234', 'devin', 'work'),
    row('PARKED-DEP.devin', 'RQ-REBASE-PHANTOM-1234-def5678', 'devin', 'work'),
    row('READY', 'RQ-REBASE-PHANTOM-2000-aaa0001', 'codex', 'work'),
    row('PARKED-HOLD', 'RQ-TEST-9', 'devin', 'work'),
  ].join('\n'));
  await writeFile(join(queueDir, 'jobs.jsonl'), [
    merge('m-1', 'devin', minutesAgo(10)), merge('m-2', 'devin', minutesAgo(40)),
    merge('m-3', 'devin', minutesAgo(90)), merge('m-4', 'codex', minutesAgo(5)),
  ].join('\n'));
  await writeFile(join(root, 'NEEDS-MASON.md'), '# needs\n- rotate the broken seat key\n- [x] resolved nm-aaaaaaaaaaaa already done\n- approve the payment\n');
}

it('records a board the live API reader serves with real counts and age', async () => {
  await seed();
  expect((await recordLeaderBoard({ runsDir: root, nowMs: NOW_MS })).wrote).toBe(true);
  const read = await readFleetBoard({ runsDir: root });
  expect(read.status).toBe('ok');
  const response = fleetBoardResponse(read, NOW_MS + 600_000);
  expect(response).toMatchObject({ schema: 'fleet.leader-board.v1', status: 'ok', ageSeconds: 600 });
  const board = response.board!;
  expect(board.generatedAt).toBe(new Date(NOW_MS).toISOString());
  expect(board.queueDepthByTier).toEqual({ work: 4, fast: 1 });
  expect(board.conflictingPrs).toMatchObject({ count: 2, trend: 'unknown' });
  expect(board.mergesLastHour).toBe(3);
  expect(board.lanes.find((l) => l.lane === 'devin')).toMatchObject({ ready: 3, parked: 2, mergesLastHour: 2 });
  expect(board.needsMason).toMatchObject({ status: 'available', count: 2 });
  expect(board.sources).toMatchObject({ readyTsv: 'healthy', queueCounts: 'ok', needsMason: 'available' });
});

it('keeps a bounded conflict trend, then reports unknown when ready.tsv disappears', async () => {
  await seed();
  await recordLeaderBoard({ runsDir: root, nowMs: NOW_MS - 3_600_000 });
  await writeFile(join(queueDir, 'ready.tsv'), row('READY', 'RQ-REBASE-PHANTOM-1234-abc1234', 'devin', 'work'));
  const second = await recordLeaderBoard({ runsDir: root, nowMs: NOW_MS });
  expect(second.wrote && second.board.conflictingPrs).toMatchObject({ count: 1, delta: -1, trend: 'falling' });
  await rm(join(queueDir, 'ready.tsv'));
  const third = await recordLeaderBoard({ runsDir: root, nowMs: NOW_MS + 60_000 });
  expect(third.wrote).toBe(true);
  if (!third.wrote) return;
  expect(third.board.conflictingPrs).toMatchObject({ count: null, delta: null, trend: 'unknown' });
  expect(third.board.queueDepthByTier).toBeNull();
  expect(third.board.sources.readyTsv).toBe('missing');
  expect(third.board.conflictingPrs.history).toEqual([
    { at: new Date(NOW_MS - 3_600_000).toISOString(), count: 2 },
    { at: new Date(NOW_MS).toISOString(), count: 1 }]);
  const read = await readFleetBoard({ runsDir: root });
  expect(read.status).toBe('ok');
  expect(read.board?.conflictingPrs.count).toBeNull();
});

it('uses only earlier conflict samples when the clock rolls back or a tick repeats', async () => {
  const ready = join(queueDir, 'ready.tsv');
  await writeFile(ready, '');
  expect((await recordLeaderBoard({ runsDir: root, nowMs: NOW_MS - 60_000 })).wrote).toBe(true);
  await seed();
  expect((await recordLeaderBoard({ runsDir: root, nowMs: NOW_MS + 60_000 })).wrote).toBe(true);

  await writeFile(ready, row('READY', 'RQ-REBASE-PHANTOM-1234-abc1234', 'devin', 'work'));
  const rolledBack = await recordLeaderBoard({ runsDir: root, nowMs: NOW_MS });
  expect(rolledBack.wrote && rolledBack.board.conflictingPrs).toEqual({
    count: 1, delta: 1, trend: 'rising', history: [
      { at: minutesAgo(1), count: 0 },
      { at: minutesAgo(0), count: 1 },
    ],
  });

  const repeated = await recordLeaderBoard({ runsDir: root, nowMs: NOW_MS });
  expect(repeated.wrote && repeated.board.conflictingPrs).toEqual(
    rolledBack.wrote && rolledBack.board.conflictingPrs,
  );
});

it('counts lane-open work by tier without attributing it to a lane', async () => {
  await writeFile(join(queueDir, 'ready.tsv'), [
    'RQ-OPEN\tphantom\t\tfrontier\tprompts/open.md',
    'RQ-RESET-HINT\tphantom\tcodex\twork\tprompts/reset.md\t{"preferred_lane":null}',
    'RQ-HINTED\tphantom\tcodex\twork\tprompts/hinted.md',
    'RQ-PARKED\tphantom\tPARKED-DEP.codex\tfast\tprompts/parked.md',
    'RQ-INVALID\tphantom\t\tmid\tprompts/invalid.md\t{"preferred_lane":false}',
  ].join('\n'));
  expect((await recordLeaderBoard({ runsDir: root, nowMs: NOW_MS })).wrote).toBe(true);
  const { board } = await readFleetBoard({ runsDir: root });
  expect(board?.queueDepthByTier).toEqual({ frontier: 1, work: 2 });
  expect(board?.lanes.find((lane) => lane.lane === 'codex')?.ready).toBe(1);
});

it('uses router queue envelopes when counting five-column rows by tier', async () => {
  await writeFile(join(queueDir, 'ready.tsv'), [
    'RQ-ENV-HINTED\tphantom\tbad lane\tfrontier\tprompts/hinted.md',
    'RQ-ENV-OPEN\tphantom\tbad lane\twork\tprompts/open.md',
    'RQ-ENV-INVALID\tphantom\tcodex\tfast\tprompts/invalid.md',
    'RQ-ENV-INLINE\tphantom\tcodex\tmid\tprompts/inline.md\t{"preferred_lane":"codex"}',
  ].join('\n'));
  await writeFile(join(queueDir, 'router-queue.md'), [
    '- READY RQ-ENV-HINTED (P1, pool=codex): use codex',
    '- READY RQ-ENV-OPEN (P1): open supply',
    '- READY RQ-ENV-INVALID (P1, exclusive=maybe): invalid requirements',
    '- READY RQ-ENV-INLINE (P1, exclusive=maybe): superseded by inline requirements',
  ].join('\n'));

  expect((await recordLeaderBoard({ runsDir: root, nowMs: NOW_MS })).wrote).toBe(true);
  const { board } = await readFleetBoard({ runsDir: root });
  expect(board?.queueDepthByTier).toEqual({ frontier: 1, work: 1, mid: 1 });
  expect(board?.lanes.find(lane => lane.lane === 'codex')?.ready).toBe(2);
});

it('reports honest failures for hostile paths and the reader stays truthful', async () => {
  expect(await recordLeaderBoard({ runsDir: 'relative/path', nowMs: NOW_MS })).toMatchObject({ wrote: false });
  expect(await recordLeaderBoard({ runsDir: '/dev/null/impossible', nowMs: NOW_MS })).toMatchObject({ wrote: false });
  await writeFile(join(root, 'coordination'), 'occupied');
  expect(await recordLeaderBoard({ runsDir: root, nowMs: NOW_MS })).toMatchObject({ wrote: false });
  expect((await readFleetBoard({ runsDir: root })).status).toBe('unavailable');
  await rm(join(root, 'coordination'));
  await mkdir(join(root, 'coordination'));
  await writeFile(join(root, 'coordination', 'leader-board.json'), 'not json');
  expect((await readFleetBoard({ runsDir: root })).status).toBe('unavailable');
  expect(fleetBoardResponse({ status: 'unavailable', board: null }, NOW_MS).ageSeconds).toBeNull();
});
