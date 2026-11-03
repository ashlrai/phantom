import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetPrecheckWaste, fleetPrecheckWaste, precheckPrefix } from '../src/cli/fleet-precheck-waste.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const now = Date.parse('2026-11-02T12:30:00Z');
const row = (event: string, hours = 1, extra = {}) => JSON.stringify({ event, ts: new Date(now - hours * 3_600_000).toISOString(),
  job: 'RQ-ABC12MORE9', repo: 'phantom', code: 'empty', ...extra });
const read = (...lines: string[]) => async () => lines.join('\n');
afterEach(() => vi.restoreAllMocks());

it('counts skips by code, repo and first-digit prefix with UTC hours and launch shares', async () => {
  const r = await fleetPrecheckWaste(read(row('precheck_skip'), row('precheck_skip', 3), row('launch'),
    row('launch', 3, { repo: 'other', job: 'OTHER1' }), row('finish')), now);
  expect(r.totals).toEqual({ skips: 2, launches: 2, skip_share: 0.5 });
  expect(r.by_code).toMatchObject([{ name: 'empty', skips: 2 }]);
  expect(r.by_repo).toMatchObject([{ name: 'phantom', skips: 2, launches: 1, skip_share: 2 / 3 }, { name: 'other', skips: 0 }]);
  expect(r.top_prefixes[0]).toMatchObject({ name: 'RQ-ABC', skips: 2, launches: 1 });
  expect(r.hours).toEqual([
    { hour: '2026-11-02T09:00:00.000Z', skips: 1, launches: 1, skip_share: 0.5 },
    { hour: '2026-11-02T11:00:00.000Z', skips: 1, launches: 1, skip_share: 0.5 },
  ]);
  expect(r.top_prefixes[0]!.hours[0]).toMatchObject({ skips: 1, launches: 0 });
});
it('includes both time boundaries, ignores invalid rows, and counts missing labels as unknown', async () => {
  const r = await fleetPrecheckWaste(read(row('precheck_skip', 6), row('launch', 0), row('precheck_skip', 6.001),
    row('launch', -0.001), row('launch', 1, { ts: 'invalid' }), row('launch', 1, { ts: null }),
    'null', '[]', 'false', '{', row('precheck_skip', 2, { job: null, code: null, repo: null })), now);
  expect(r.totals).toEqual({ skips: 2, launches: 1, skip_share: 2 / 3 });
  expect(r.by_code.map(g => g.name)).toEqual(['empty', 'unknown']);
  expect(precheckPrefix('ABC')).toBe('ABC');
  expect(precheckPrefix('12ABC')).toBe('unknown');
});
it('keeps only ten prefixes, ordered by skips then name without truncating totals', async () => {
  const rows = Array.from({ length: 12 }, (_, i) => row('precheck_skip', 1, { job: `PREFIX${String.fromCharCode(65 + i)}1` }));
  const r = await fleetPrecheckWaste(read(...rows.reverse(), row('precheck_skip', 1, { job: 'PREFIXL2' })), now);
  expect(r.top_prefixes).toHaveLength(10);
  expect(r.top_prefixes.map(g => g.name)).toEqual(['PREFIXL', ...'ABCDEFGHI'.split('').map(c => `PREFIX${c}`)]);
  expect(r.totals!.skips).toBe(13);
});
it('distinguishes unreadable metrics from readable empty data', async () => {
  for (const reader of [async () => null, async () => { throw Error('denied'); }]) {
    expect(await fleetPrecheckWaste(reader, now)).toMatchObject({ known: false, totals: null });
  }
  expect(await fleetPrecheckWaste(read(), now)).toMatchObject({ known: true, totals: { skips: 0, launches: 0, skip_share: 0 } });
});
it('registers the verb and exposes JSON, plain text, help and usage without reading on invalid args', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect((await FLEET_SUBCOMMAND_LOADERS['precheck-waste']!()).cmdFleetPrecheckWaste).toBe(cmdFleetPrecheckWaste);
  expect(await cmdFleetPrecheckWaste(['--json'], read(row('precheck_skip')), now)).toBe(0);
  expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({ schema: 'fleet.precheck-waste.v1', totals: { skips: 1 } });
  await cmdFleetPrecheckWaste([], read(row('precheck_skip')), now);
  expect(log.mock.calls[1]![0]).toContain('100.0% skipped');
  await cmdFleetPrecheckWaste([], async () => null, now);
  expect(log.mock.calls[2]![0]).toContain('unknown');
  const reader = vi.fn(read());
  for (const args of [['--help'], ['-h']]) expect(await cmdFleetPrecheckWaste(args, reader)).toBe(0);
  for (const args of [['bad'], ['--json', '--json']]) expect(await cmdFleetPrecheckWaste(args, reader)).toBe(2);
  expect(reader).not.toHaveBeenCalled();
});
