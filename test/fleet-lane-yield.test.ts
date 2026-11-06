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

it('is red only when skips are over half of 10 or more rows', async () => {
  const skips = (n: number, lane: string) => Array.from({ length: n }, (_, i) => row('precheck_skip', `${lane}s${i}`, 1, { lane, code: 13 }));
  const launches = (n: number, lane: string) => Array.from({ length: n }, (_, i) => row('launch', `${lane}l${i}`, 1, { lane }));
  const r = await fleetLaneYield(read(...skips(6, 'a'), ...launches(4, 'a'), ...skips(5, 'b'), ...launches(5, 'b'), ...skips(5, 'c'), ...launches(3, 'c')), 2, now);
  expect(Object.fromEntries(r.lanes.map(x => [x.lane, x.red]))).toEqual({ a: true, b: false, c: false });
  expect(r.red).toBe(true);
});

it('reports unknown when the ledger is unreadable or throws', async () => {
  for (const reader of [async () => null, async () => { throw new Error('boom'); }]) {
    expect(await fleetLaneYield(reader, 2, now)).toMatchObject({ known: false, red: false, lanes: [] });
  }
  await expect(fleetLaneYield(read(), 0, now)).rejects.toThrow(RangeError);
});

it('prints json, exits 1 on red and 0 otherwise, and rejects bad flags', async () => {
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

it('is registered as a fleet verb', async () => {
  expect((await FLEET_SUBCOMMAND_LOADERS['lane-yield']!()).cmdFleetLaneYield).toBe(cmdFleetLaneYield);
});
