import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetFillerYield, fleetFillerYield, FILLER_ID } from '../src/cli/fleet-filler-yield.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const now = Date.parse('2026-11-03T12:00:00Z');
const row = (event: string, job: string, hours = 1, extra = {}) => JSON.stringify({ event, job,
  ts: new Date(now - hours * 3_600_000).toISOString(), ...extra });
const read = (...rows: string[]) => async () => rows.join('\n');
const J = (n: number) => `RQ-FOO${n}A123456Q8`;
afterEach(() => vi.restoreAllMocks());

it('matches only author-filler ids', () => {
  expect(FILLER_ID.test('RQ-FOO1A123456Q8')).toBe(true);
  for (const bad of ['RQ-FOO1A123456Q9', 'RQ-FOOA123456Q8', 'rq-FOO1A1Q8', 'RQ-FOO1A1Q8x', 'RQ-PHX-X03', 'XRQ-FOO1A1Q8']) expect(FILLER_ID.test(bad)).toBe(false);
});

it('counts per repo from a fixture file, joins repo via launch, and ignores other ids, codes, old and future rows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'filler-yield-'));
  try {
    const path = join(dir, 'jobs.jsonl');
    await writeFile(path, [
      row('launch', J(1), 2, { repo: 'phantom' }), row('launch', J(2), 2, { repo: 'phantom' }),
      row('precheck_skip', J(3), 1, { repo: 'phantom', code: 13 }), row('precheck_skip', J(4), 1, { repo: 'phantom', code: 7 }),
      row('finish', J(1), 1, { empty: true }), row('finish', J(2), 1, { empty: 'true' }),
      row('outcome', J(1), 1, { state: 'MERGED' }), row('outcome', J(1), 0.5, { state: 'MERGED' }), row('outcome', J(2), 1, { state: 'CLOSED' }),
      row('launch', 'RQ-PHX-REAL03', 1, { repo: 'phantom' }), row('launch', J(5), 7, { repo: 'phantom' }), row('launch', J(6), -1, { repo: 'phantom' }),
      row('launch', J(7), 1, { repo: 'other' }), '{', 'null', '[]'].join('\n'));
    const report = await fleetFillerYield(() => readFile(path, 'utf8'), 6, now);
    expect(report.known).toBe(true);
    expect(report.repos).toEqual([
      { repo: 'other', launches: 1, skips: 0, empty_finishes: 0, merged: 0, rows: 1, yield: 0, red: false },
      { repo: 'phantom', launches: 2, skips: 1, empty_finishes: 1, merged: 1, rows: 9, yield: 1 / 3, red: false },
    ]);
    expect(report.red).toBe(false);
    expect((await fleetFillerYield(() => readFile(path, 'utf8'), 24, now)).repos[1]!.launches).toBe(3);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('is red only when skips are over half of 10 or more rows', async () => {
  const skips = (n: number, repo: string) => Array.from({ length: n }, (_, i) => row('precheck_skip', J(100 + i), 1, { repo, code: 13 }));
  const launches = (n: number, repo: string) => Array.from({ length: n }, (_, i) => row('launch', J(200 + i), 1, { repo }));
  const r = await fleetFillerYield(read(...skips(6, 'a'), ...launches(4, 'a'), ...skips(5, 'b'), ...launches(5, 'b'), ...skips(5, 'c'), ...launches(3, 'c')), 6, now);
  expect(Object.fromEntries(r.repos.map(x => [x.repo, x.red]))).toEqual({ a: true, b: false, c: false });
  expect(r.red).toBe(true);
});

it('reports unknown when the ledger is unreadable or throws', async () => {
  for (const reader of [async () => null, async () => { throw new Error('boom'); }]) {
    expect(await fleetFillerYield(reader, 6, now)).toMatchObject({ known: false, red: false, repos: [] });
  }
  await expect(fleetFillerYield(read(), 0, now)).rejects.toThrow(RangeError);
});

it('prints json, exits 1 on red and 0 otherwise, and rejects bad flags', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const red = read(...Array.from({ length: 10 }, (_, i) => row('precheck_skip', J(i), 1, { repo: 'phantom', code: 13 })));
  expect(await cmdFleetFillerYield(['--json'], red, now)).toBe(1);
  expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ schema: 'fleet.filler-yield.v1', red: true });
  expect(await cmdFleetFillerYield([], red, now)).toBe(1);
  expect(log.mock.calls[1]![0]).toContain('phantom: yield 0.0% (0 merged / 0 launches + 10 skips)');
  expect(log.mock.calls[1]![0]).toContain('RED');
  expect(await cmdFleetFillerYield(['--hours', '0.001'], red, now)).toBe(0);
  expect(await cmdFleetFillerYield([], read(row('launch', J(1), 1, { repo: 'x' })), now)).toBe(0);
  expect(await cmdFleetFillerYield([], async () => null, now)).toBe(0);
  expect(await cmdFleetFillerYield(['-h'], red, now)).toBe(0);
  for (const bad of [['--hours'], ['--hours', 'x'], ['--hours', '-1'], ['--json', '--json'], ['--nope']]) expect(await cmdFleetFillerYield(bad, red, now)).toBe(2);
  expect(err).toHaveBeenCalled();
});

it('is registered as a fleet verb', async () => {
  expect((await FLEET_SUBCOMMAND_LOADERS['filler-yield']!()).cmdFleetFillerYield).toBe(cmdFleetFillerYield);
});
