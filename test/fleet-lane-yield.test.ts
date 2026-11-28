import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetLaneYield, fleetLaneYield } from '../src/cli/fleet-lane-yield.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const now = Date.parse('2026-11-03T12:00:00Z');
const row = (event: string, job: string, hours = 1, extra = {}) => JSON.stringify({ event, job,
  ts: new Date(now - hours * 3_600_000).toISOString(), ...extra });
const read = (...rows: string[]) => async () => rows.join('\n');
afterEach(() => vi.restoreAllMocks());

it('counts per lane from a fixture file, joins outcomes via the launch row, and ignores old and future rows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lane-yield-'));
  try {
    const path = join(dir, 'jobs.jsonl');
    await writeFile(path, [
      row('launch', 'A1', 1.5, { lane: 'codex-personal' }), row('launch', 'A2', 1.5, { lane: 'codex-personal' }),
      row('precheck_skip', 'A3', 1, { lane: 'codex-personal', code: 13 }), row('precheck_skip', 'A4', 1, { lane: 'codex-personal', code: 7 }),
      row('precheck_skip', 'A5', 1, { lane: 'codex-personal', code: 13 }), row('precheck_skip', 'A6', 1, { lane: 'codex-personal' }),
      row('finish', 'A1', 1, { empty: true }), row('finish', 'A2', 1, { empty: 'true' }), row('finish', 'A2', 1, { empty: false }),
      row('outcome', 'A1', 1, { state: 'MERGED' }), row('outcome', 'A1', 0.5, { state: 'MERGED' }), row('outcome', 'A2', 1, { state: 'CLOSED' }),
      row('launch', 'A7', 3, { lane: 'codex-personal' }), row('launch', 'A8', -1, { lane: 'codex-personal' }),
      row('launch', 'B1', 1, { lane: 'claude' }), row('outcome', 'B1', 1, { state: 'MERGED' }), row('outcome', 'Z9', 1, { state: 'MERGED' }),
      '{', 'null', '[]'].join('\n'));
    const report = await fleetLaneYield(() => readFile(path, 'utf8'), 2, now);
    expect(report.known).toBe(true);
    expect(report.lanes).toEqual([
      { lane: 'claude', launches: 1, skips_by_code: {}, skips: 0, empty_finishes: 0, merged: 1, rows: 2, yield: 1, red: false },
      { lane: 'codex-personal', launches: 2, skips_by_code: { 13: 2, 7: 1, none: 1 }, skips: 4, empty_finishes: 1, merged: 1, rows: 12, yield: 1 / 6, red: false },
      { lane: 'unknown', launches: 0, skips_by_code: {}, skips: 0, empty_finishes: 0, merged: 1, rows: 1, yield: null, red: false },
    ]);
    expect((await fleetLaneYield(() => readFile(path, 'utf8'), 24, now)).lanes[1]!.launches).toBe(3);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('lane-yield is red only when skips are over half of 10 or more rows', async () => {
  const skips = (n: number, lane: string) => Array.from({ length: n }, (_, i) => row('precheck_skip', `${lane}s${i}`, 1, { lane, code: 13 }));
  const launches = (n: number, lane: string) => Array.from({ length: n }, (_, i) => row('launch', `${lane}l${i}`, 1, { lane }));
  const r = await fleetLaneYield(read(...skips(6, 'a'), ...launches(4, 'a'), ...skips(5, 'b'), ...launches(5, 'b'), ...skips(5, 'c'), ...launches(3, 'c')), 2, now);
  expect(Object.fromEntries(r.lanes.map(x => [x.lane, x.red]))).toEqual({ a: true, b: false, c: false });
  expect(r.red).toBe(true);
});

it('counts code-carrying skipped_empty rows as skips and ignores empty-gate declines', async () => {
  const r = await fleetLaneYield(read(
    row('skipped_empty', 'L1', 1, { lane: 'claude', code: 10 }),
    row('skipped_empty', 'L2', 1, { lane: 'claude', code: 14 }),
    row('skipped_empty', 'L3', 1, { lane: 'claude', reason: 'task_empty_repeat_24h' }),
    row('skipped_empty', 'L4', 1, { lane: 'claude', code: 10, applied: false }),
    row('launch', 'L5', 1, { lane: 'claude' }),
  ), 2, now);
  expect(r.lanes).toEqual([
    { lane: 'claude', launches: 1, skips_by_code: { 10: 1, 14: 1 }, skips: 2, empty_finishes: 0, merged: 0, rows: 5, yield: 0, red: false },
  ]);
});
it('folds the full jobs-ledger dialect and skips node-pool and batch-session machinery', async () => {
  const iso = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
  const r = await fleetLaneYield(read(
    // Launches through type/jobId/pool/timestamp and arm spellings.
    JSON.stringify({ type: 'launch', jobId: 'D1', pool: 'claude', timestamp: iso(1) }),
    JSON.stringify({ event: 'launch', job: 'D2', lane: 'codex-personal', ts: iso(1) }),
    JSON.stringify({ kind: 'launch', job: 'D3', lane: 'codex-personal', time: iso(1) }),
    JSON.stringify({ event: 'launch', job: 'D4', lane: 'codex-personal', ts: iso(1) }),
    JSON.stringify({ event: 'launch', job: 'D5', lane: 'codex-personal', ts: iso(1) }),
    JSON.stringify({ event: 'launch', job: 'D6', arm: 'arm-lane', ts: iso(1) }),
    JSON.stringify({ type: 'precheck_skip', jobId: 'S1', code: 13, pool: 'claude', timestamp: iso(1) }),
    // Merges through every dialect spelling: kind/status outcome, eventless
    // resolved phase, publish-shaped reconciler row, merged flag.
    JSON.stringify({ kind: 'outcome', job: 'D1', status: 'MERGED', at: iso(0.5) }),
    JSON.stringify({ jobId: 'D2', outcome: 'MERGED', mergedAt: iso(0.5), source: 'metrics-outcomes-reconciler' }),
    JSON.stringify({ job: 'D3', event: 'publish', outcome: 'MERGED', source: 'metrics-outcomes-reconciler', mergedAt: iso(0.5) }),
    JSON.stringify({ job: 'D4', merged: true, ts: iso(0.5) }),
    // Empty finishes through finished/complete spellings and terminal phases.
    JSON.stringify({ type: 'finished', job: 'D5', empty: true, timestamp: iso(0.5) }),
    JSON.stringify({ event: 'outcome', job: 'D6', phase: 'EMPTY_DONE', ts: iso(0.5) }),
    // Machinery rows: session-pool, node-runner and RQ-BATCH launches never count.
    JSON.stringify({ schema: 'fleet.session-pool.v1', event: 'launch', job: 'sess:1', jobId: 'ready:X:1', lane: 'claude', ts: iso(0.5) }),
    JSON.stringify({ schema: 'phm-node-runner.v1', event: 'finish', job: 'X:tok', jobId: 'ready:X:1', lane: 'claude', outcome: 'SUCCESS', ts: iso(0.5) }),
    JSON.stringify({ event: 'launch', job: 'RQ-BATCH-42', lane: 'claude', ts: iso(0.5) }),
  ), 2, now);
  expect(r.lanes).toEqual([
    { lane: 'arm-lane', launches: 1, skips_by_code: {}, skips: 0, empty_finishes: 1, merged: 0, rows: 2, yield: 0, red: false },
    { lane: 'claude', launches: 1, skips_by_code: { 13: 1 }, skips: 1, empty_finishes: 0, merged: 1, rows: 3, yield: 0.5, red: false },
    { lane: 'codex-personal', launches: 4, skips_by_code: {}, skips: 0, empty_finishes: 1, merged: 3, rows: 8, yield: 0.75, red: false },
  ]);
});

it('lane-yield reports unknown when the ledger is unreadable or throws', async () => {
  for (const reader of [async () => null, async () => { throw new Error('boom'); }]) {
    expect(await fleetLaneYield(reader, 2, now)).toMatchObject({ known: false, red: false, lanes: [] });
  }
  await expect(fleetLaneYield(read(), 0, now)).rejects.toThrow(RangeError);
});

it('lane-yield prints json, exits 1 on red and 0 otherwise, and rejects bad flags', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const red = read(...Array.from({ length: 10 }, (_, i) => row('precheck_skip', `J${i}`, 1, { lane: 'codex-personal', code: 13 })));
  expect(await cmdFleetLaneYield(['--json'], red, now)).toBe(1);
  expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ schema: 'fleet.lane-yield.v1', red: true });
  expect(await cmdFleetLaneYield([], red, now)).toBe(1);
  expect(log.mock.calls[1]![0]).toContain('codex-personal: yield 0.0% (0 merged / 0 launches + 10 skips [13:10])');
  expect(log.mock.calls[1]![0]).toContain('RED');
  expect(await cmdFleetLaneYield(['--hours', '0.001'], red, now)).toBe(0);
  expect(await cmdFleetLaneYield([], read(row('launch', 'J1', 1, { lane: 'x' })), now)).toBe(0);
  expect(await cmdFleetLaneYield([], async () => null, now)).toBe(0);
  expect(await cmdFleetLaneYield(['-h'], red, now)).toBe(0);
  for (const bad of [['--hours'], ['--hours', 'x'], ['--hours', '-1'], ['--json', '--json'], ['--nope']]) expect(await cmdFleetLaneYield(bad, red, now)).toBe(2);
  expect(err).toHaveBeenCalled();
});

it('lane-yield is registered as a fleet verb', async () => {
  expect((await FLEET_SUBCOMMAND_LOADERS['lane-yield']!()).cmdFleetLaneYield).toBe(cmdFleetLaneYield);
});
