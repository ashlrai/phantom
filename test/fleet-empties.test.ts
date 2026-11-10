import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetEmpties, fleetEmpties } from '../src/cli/fleet-empties.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const now = Date.parse('2026-11-09T12:00:00Z');
const fixture = [
  ['codex', 'phantom', 'already covered'], ['codex', 'phantom', 'already covered'],
  ['codex', 'phantom', 'already covered'], ['claude', 'phantom', 'already covered'],
  ['codex', 'locus', 'missing input'], ['codex', 'locus', 'missing input'],
  ['codex', 'phantom', null], ['codex', 'phantom', ''],
  ['claude', 'locus', 'blocked'], [null, null, 'other'],
].map(([lane, repo, reason], index) => JSON.stringify({ event: 'outcome', empty: true, job: `J${index}`, ts: new Date(now - 3600000).toISOString(), lane, repo, reason })).join('\n');
afterEach(() => vi.restoreAllMocks());

it('groups ten recorded empties and ranks reasons without guessing', async () => {
  const report = await fleetEmpties(async () => fixture, 24, now);
  expect(report.total).toBe(10);
  expect(report.groups).toContainEqual({ lane: 'codex', repo: 'phantom', reason: 'already covered', count: 3 });
  expect(report.groups).toContainEqual({ lane: 'codex', repo: 'phantom', reason: 'unknown', count: 2 });
  expect(report.groups).toContainEqual({ lane: 'unknown', repo: 'unknown', reason: 'other', count: 1 });
  expect(report.top_reasons.map(({ reason, count }) => [reason, count])).toEqual([
    ['already covered', 4], ['missing input', 2], ['unknown', 2], ['blocked', 1], ['other', 1],
  ]);
  expect(report.top_reasons.find(r => r.reason === 'unknown')?.suggested_filler_rule).toContain('Record');
});
it('filters the window and explicit outcomes, and distinguishes unavailable data', async () => {
  const row = (fields: object) => JSON.stringify({ ts: new Date(now).toISOString(), ...fields });
  const input = [fixture, row({ event: 'EMPTY_DONE', reason: 'new' }), row({ event: 'finish', empty: false }),
    row({ event: 'EMPTY_DONE', ts: new Date(now - 25 * 3600000).toISOString() }), row({ event: 'EMPTY_DONE', ts: new Date(now + 1).toISOString() }), '{'].join('\n');
  expect((await fleetEmpties(async () => input, 24, now)).total).toBe(11);
  expect(await fleetEmpties(async () => null, 24, now)).toMatchObject({ known: false, total: null });
  expect(await fleetEmpties(async () => '', 24, now)).toMatchObject({ known: true, total: 0 });
});
it('registers and validates the CLI and emits JSON', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
  expect((await FLEET_SUBCOMMAND_LOADERS.empties!()).cmdFleetEmpties).toBe(cmdFleetEmpties);
  const read = vi.fn(async () => fixture);
  for (const args of [['--since'], ['--since', '0h'], ['--since', '1d'], ['--json', '--json'], ['bad']]) expect(await cmdFleetEmpties(args, read, now)).toBe(2);
  expect(read).not.toHaveBeenCalled();
  expect(await cmdFleetEmpties(['--since', '24h', '--json'], read, now)).toBe(0);
  expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({ schema: 'fleet.empties.v1', total: 10 });
});
