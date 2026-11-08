import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetBoard } from '../src/cli/fleet-board.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import {
  LEADER_BOARD_SCHEMA, conflictingPrIds, queueDepthByTier, readLeaderBoard, readyRowsForDepth, recordLeaderBoard,
} from '../src/core/fleet/leader-board.js';
import { leaderTick, type LeaderRunDeps } from '../src/core/vision/leader.js';
import type { LeaderApplyDeps } from '../src/core/vision/leader-apply.js';
import type { LeaderEvidenceSources } from '../src/core/vision/leader.js';
import type { LeaderSeatDeps } from '../src/core/vision/leader-seat.js';
import type { AshlrConfig } from '../src/core/types.js';

const NOW_MS = Date.parse('2026-11-07T15:00:00Z');
const minutesAgo = (m: number) => new Date(NOW_MS - m * 60_000).toISOString();
const row = (status: string, id: string, pool: string, tier: string) => `${status}\t${id}\t${pool}\t${tier}\texample/phantom\tFixture`;
const merge = (job: string, lane: string, ts: string) =>
  JSON.stringify({ job, lane, event: 'outcome', state: 'MERGED', ts });

let root: string;
let queueDir: string;
let savedRunsDir: string | undefined;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'leader-board-'));
  queueDir = join(root, 'queue');
  await mkdir(queueDir, { recursive: true });
  savedRunsDir = process.env['ASHLR_RUNS_DIR'];
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (savedRunsDir === undefined) delete process.env['ASHLR_RUNS_DIR'];
  else process.env['ASHLR_RUNS_DIR'] = savedRunsDir;
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
    merge('m-1', 'devin', minutesAgo(10)),
    merge('m-2', 'devin', minutesAgo(40)),
    merge('m-3', 'devin', minutesAgo(90)),
    merge('m-4', 'codex', minutesAgo(5)),
  ].join('\n'));
  await writeFile(join(root, 'NEEDS-MASON.md'),
    '# needs\n- rotate the broken seat key\n- [x] resolved nm-aaaaaaaaaaaa already done\n- approve the payment\n');
}

describe('recordLeaderBoard', () => {
  it('writes a fleet.leader-board.v1 snapshot covering lanes, tiers, merges, conflicts and needs-Mason', async () => {
    await seed();
    const result = await recordLeaderBoard({ runsDir: root, nowMs: NOW_MS });
    expect(result.wrote).toBe(true);
    const stored = JSON.parse(await readFile(join(root, 'coordination', 'leader-board.json'), 'utf8'));
    expect(stored.schema).toBe(LEADER_BOARD_SCHEMA);
    expect(stored.generatedAt).toBe(new Date(NOW_MS).toISOString());
    expect(stored.queueDepthByTier).toEqual({ work: 4, fast: 1 });
    expect(stored.mergesLastHour).toBe(3);
    expect(stored.conflictingPrs.count).toBe(2); // 1234 counted once across two rebase rows
    expect(stored.conflictingPrs.trend).toBe('unknown');
    expect(stored.lanes.map((l: { lane: string }) => l.lane)).toEqual(['codex', 'devin']);
    const devin = stored.lanes.find((l: { lane: string }) => l.lane === 'devin');
    expect(devin).toMatchObject({ ready: 3, parked: 2, mergesLastHour: 2 });
    expect(stored.needsMason.status).toBe('available');
    expect(stored.needsMason.count).toBe(2);
    expect(stored.needsMason.items.map((i: { id: string }) => i.id).every((id: string) => id.startsWith('nm-'))).toBe(true);
    expect(stored.sources).toMatchObject({ readyTsv: 'healthy', queueCounts: 'ok', needsMason: 'available' });
  });

  it('keeps a bounded trend across records: delta and direction follow the samples', async () => {
    await seed();
    const first = await recordLeaderBoard({ runsDir: root, nowMs: NOW_MS - 3_600_000 });
    expect(first.wrote).toBe(true);
    // The second tick sees only one rebase PR left in the queue.
    await writeFile(join(queueDir, 'ready.tsv'), row('READY', 'RQ-REBASE-PHANTOM-1234-abc1234', 'devin', 'work'));
    const second = await recordLeaderBoard({ runsDir: root, nowMs: NOW_MS });
    if (!second.wrote) throw new Error('unreachable');
    expect(second.board.conflictingPrs).toMatchObject({ count: 1, delta: -1, trend: 'falling' });
    expect(second.board.conflictingPrs.history).toEqual([
      { at: new Date(NOW_MS - 3_600_000).toISOString(), count: 2 },
      { at: new Date(NOW_MS).toISOString(), count: 1 },
    ]);
  });

  it('reports unknown conflict figures, not a stale trend, when ready.tsv is unreadable', async () => {
    await seed();
    await recordLeaderBoard({ runsDir: root, nowMs: NOW_MS - 3_600_000 });
    await rm(join(queueDir, 'ready.tsv'));
    const result = await recordLeaderBoard({ runsDir: root, nowMs: NOW_MS });
    if (!result.wrote) throw new Error('unreachable');
    expect(result.board.conflictingPrs).toMatchObject({ count: null, delta: null, trend: 'unknown' });
    expect(result.board.queueDepthByTier).toBeNull();
    expect(result.board.sources.readyTsv).toBe('missing');
    expect(result.board.conflictingPrs.history).toHaveLength(1); // the earlier sample is retained
  });

  it('still writes with an empty runs dir and never throws on a hostile path', async () => {
    const result = await recordLeaderBoard({ runsDir: root, nowMs: NOW_MS });
    expect(result.wrote).toBe(true);
    if (!result.wrote) throw new Error('unreachable');
    expect(result.board.needsMason.status).toBe('missing');
    expect(result.board.queueDepthByTier).toBeNull();
    await expect(recordLeaderBoard({ runsDir: '/dev/null/impossible', nowMs: NOW_MS })).resolves.toMatchObject({ wrote: false });
  });
});

describe('readLeaderBoard', () => {
  it('distinguishes missing, unreadable and healthy boards', async () => {
    expect((await readLeaderBoard({ runsDir: root })).status).toBe('missing');
    const path = join(root, 'coordination', 'leader-board.json');
    await mkdir(join(root, 'coordination'), { recursive: true });
    await writeFile(path, 'not json');
    expect((await readLeaderBoard({ runsDir: root })).status).toBe('unavailable');
    await writeFile(path, JSON.stringify({ schema: 'other.v1' }));
    expect((await readLeaderBoard({ runsDir: root })).status).toBe('unavailable');
    await recordLeaderBoard({ runsDir: root, nowMs: NOW_MS });
    const read = await readLeaderBoard({ runsDir: root });
    expect(read.status).toBe('ok');
    expect(read.board?.schema).toBe(LEADER_BOARD_SCHEMA);
  });
});

describe('the conflict proxy and tier counts are pure', () => {
  it('counts distinct PRs across rebase heads and parked encodings, ignoring other rows', () => {
    const ids = conflictingPrIds([
      'READY\tRQ-REBASE-PHANTOM-1234-abc1234\tdevin\twork',
      'PARKED-DEP.devin\tRQ-REBASE-PHANTOM-1234-def5678\tdevin\twork',
      'RQ-REBASE-SECRETS-7-111aaaa\towner/repo\tPARKED-DEP.codex\twork\tprompt',
      'READY\tRQ-REBASE-PHANTOM-1234-zzz\tdevin\twork', // not a rebase row: sha is not hex
      '# comment mentioning RQ-REBASE-PHANTOM-9-0000000',
      'READY\tRQ-TEST-1\tdevin\twork',
    ].join('\n'));
    expect([...ids].sort()).toEqual(['PHANTOM-1234', 'SECRETS-7']);
  });

  it('drops both parked-row encodings from the READY depth parse', () => {
    const text = [
      row('READY', 'RQ-TEST-1', 'devin', 'work'),
      row('READY', 'RQ-TEST-2', 'devin', 'FAST'),
      'PARKED-DEP.devin\tRQ-TEST-3\tdevin\twork\texample/phantom\tFixture',
      'RQ-TEST-4\texample/phantom\tPARKED-DEP.devin\twork\tprompt',
      'READY\tRQ-TEST-5\tdevin\tnot a tier!',
    ].join('\n');
    expect(queueDepthByTier(readyRowsForDepth(text))).toEqual({ work: 1, fast: 1, unknown: 1 });
  });
});

describe('phm fleet board', () => {
  it('prints a missing-board message and the JSON envelope, exits 0', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetBoard([], { readBoard: async () => ({ status: 'missing', board: null }) })).toBe(0);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining('No Leader board'));
    expect(await cmdFleetBoard(['--json'], { readBoard: async () => ({ status: 'missing', board: null }) })).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toEqual({
      schema: LEADER_BOARD_SCHEMA, status: 'missing', ageSeconds: null, board: null,
    });
  });

  it('prints the board summary and JSON, exits 1 only when the file is unreadable', async () => {
    await seed();
    const recorded = await recordLeaderBoard({ runsDir: root, nowMs: NOW_MS });
    if (!recorded.wrote) throw new Error('unreachable');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const read = { readBoard: async () => ({ status: 'ok' as const, board: recorded.board }), now: () => NOW_MS + 600_000 };
    expect(await cmdFleetBoard([], read)).toBe(0);
    expect(log.mock.calls.map((call) => String(call[0])).join('\n')).toContain('needs Mason: 2');
    expect(await cmdFleetBoard(['--json'], read)).toBe(0);
    const out = JSON.parse(log.mock.calls.at(-1)![0] as string);
    expect(out).toMatchObject({ schema: LEADER_BOARD_SCHEMA, status: 'ok', ageSeconds: 600 });
    expect(out.board.conflictingPrs.count).toBe(2);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await cmdFleetBoard(['--json'], { readBoard: async () => ({ status: 'unavailable', board: null }) })).toBe(1);
    expect(await cmdFleetBoard(['--bad-flag'], read)).toBe(2);
    expect(err).toHaveBeenCalled();
  });

  it('is registered in the fleet subcommand registry', async () => {
    expect((await FLEET_SUBCOMMAND_LOADERS['board']!())['cmdFleetBoard']).toBe(cmdFleetBoard);
  });
});

describe('the tick records the board', () => {
  const stubDeps = (board: LeaderRunDeps['board']): LeaderRunDeps => ({
    cfg: {} as AshlrConfig,
    liveConfig: () => { throw new Error('config unavailable'); },
    now: () => NOW_MS,
    sources: {} as LeaderEvidenceSources,
    seat: {} as LeaderSeatDeps,
    apply: { now: () => NOW_MS } as unknown as LeaderApplyDeps,
    ...(board ? { board } : {}),
  });

  it('calls the injected recorder even on the early-return path', async () => {
    const record = vi.fn(async () => ({ wrote: false }));
    const tick = await leaderTick(stubDeps({ record }), { awaitRun: true });
    expect(record).toHaveBeenCalledWith(NOW_MS);
    expect(tick.due.due).toBe(false);
  });

  it('writes the real board when no recorder is injected', async () => {
    process.env['ASHLR_RUNS_DIR'] = root;
    await seed();
    await leaderTick(stubDeps(undefined), { awaitRun: true });
    const read = await readLeaderBoard({ runsDir: root });
    expect(read.status).toBe('ok');
    expect(read.board?.conflictingPrs.count).toBe(2);
  });
});
