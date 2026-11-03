import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetWaste, fleetWaste, wastePrefix } from '../src/cli/fleet-waste.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
const now = Date.parse('2026-11-02T12:00:00Z');
const row = (event: string, job = 'RQ-FOOA123456Q8', hours = 1, extra = {}) => JSON.stringify({ event, job,
  ts: new Date(now - hours * 3_600_000).toISOString(), ...extra });
const read = (...rows: string[]) => async () => rows.join('\n');
afterEach(() => vi.restoreAllMocks());
it('reads a fixture file, joins missing repo fields and counts rows and distinct jobs without a PR', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-waste-'));
  try {
    const path = join(dir, 'jobs.jsonl');
    await writeFile(path, [row('finish', undefined, 0.5, { lane: 'codex', empty: true, pool_error: 'timeout' }),
      row('launch', undefined, 2, { lane: 'codex', repo: 'phantom' }), row('launch', undefined, 1, { lane: 'codex', repo: 'phantom' }),
      row('precheck_skip', 'SKIP1', 6, { lane: 'claude', repo: 'other', code: 7 }),
      row('precheck_skip', 'SKIP2', 1, { lane: 'claude', repo: 'other', code: 'empty' }),
      row('launch', 'PR1', 1, { lane: 'claude', repo: 'other' }), row('publish', 'PR1', 0, { url: 'https://github.com/a/b/pull/1' }),
      row('launch', 'OLD1', 7, { lane: 'codex', repo: 'phantom' }), row('finish', 'OLD1', 1, { empty: true }),
      row('precheck_skip', 'IGNORE1', 6.01), row('finish', 'FUTURE1', -1, { empty: true }), '{', 'null', '[]'].join('\n'));
    const report = await fleetWaste(() => readFile(path, 'utf8'), 6, now);
    expect(report.totals).toEqual({ precheck_skip: { '7': 1, empty: 1 }, empty: 2, pool_error: 1, no_pr: 1 });
    expect(report.by_lane).toEqual([
      { name: 'claude', counts: { precheck_skip: { '7': 1, empty: 1 }, empty: 0, pool_error: 0, no_pr: 0 } },
      { name: 'codex', counts: { precheck_skip: {}, empty: 2, pool_error: 1, no_pr: 1 } },
    ]);
    expect(report.by_repo.find(g => g.name === 'phantom')?.counts.empty).toBe(2);
    expect(report.top_prefixes).toEqual([{ prefix: 'RQ-FOOQ', count: 2 }, { prefix: 'SKIP', count: 2 }, { prefix: 'OLD', count: 1 }]);
    expect((await fleetWaste(() => readFile(path, 'utf8'), 0.25, now)).totals?.no_pr).toBe(0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
it('keeps five prefixes, counts overlapping finish reasons once and ignores invalid timestamps', async () => {
  const report = await fleetWaste(read(...'ABCDEFG'.split('').map(c => row('finish', `${c}1`, 1, { empty: true, pool_error: 'error' })),
    row('finish', 'A2', 1, { empty: true }), row('finish', 'BAD1', 1, { ts: 'bad', empty: true }),
    row('finish', 'NO1', 1, { empty: 'true', pool_error: null })), 6, now);
  expect(report.top_prefixes).toEqual([{ prefix: 'A', count: 2 }, ...'BCDE'.split('').map(prefix => ({ prefix, count: 1 }))]);
  expect(report.totals).toMatchObject({ empty: 8, pool_error: 7 });
  expect(wastePrefix('ABC12MID9A123456Q8')).toBe('ABC12MID9Q');
});
it('distinguishes unavailable data from no waste and handles prototype-shaped codes', async () => {
  for (const reader of [async () => null, async () => { throw Error('denied'); }]) expect(await fleetWaste(reader)).toMatchObject({ known: false, totals: null });
  expect(await fleetWaste(read())).toMatchObject({ known: true, totals: { no_pr: 0 } });
  const r = await fleetWaste(read(row('precheck_skip', 'X1', 1, { code: '__proto__' })), 6, now);
  expect(Object.hasOwn(r.totals!.precheck_skip, '__proto__')).toBe(true);
  expect(r.totals!.precheck_skip['__proto__']).toBe(1);
});
it('registers the command and validates options before reading', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
  expect((await FLEET_SUBCOMMAND_LOADERS['waste']!()).cmdFleetWaste).toBe(cmdFleetWaste);
  const reader = vi.fn(read());
  for (const args of [['--hours'], ['--hours', '0'], ['--hours', '-1'], ['--hours', 'Infinity'], ['--json', '--json'], ['bad']]) expect(await cmdFleetWaste(args, reader)).toBe(2);
  expect(await cmdFleetWaste(['--help'], reader)).toBe(0); expect(reader).not.toHaveBeenCalled();
  expect(await cmdFleetWaste(['--hours', '2', '--json'], reader, now)).toBe(0);
  expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({ schema: 'fleet.waste.v1', window_hours: 2 });
  await cmdFleetWaste([], async () => null, now); expect(log.mock.calls.at(-1)![0]).toContain('unknown');
  await cmdFleetWaste([], read(row('finish', 'X1', 1, { empty: true })), now); expect(log.mock.calls.at(-1)![0]).toContain('1 empty finishes');
});
