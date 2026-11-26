import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { cmdFleetIdleLanes } from '../src/cli/fleet-idle-lanes.js';

const dirs: string[] = [];
const NOW = Date.parse('2026-11-02T12:00:30Z');
const TICK = new Date(NOW).toISOString();
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
async function fixture(contents: unknown) {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  const dir = await mkdtemp(join(tmpdir(), 'idle-lanes-'));
  dirs.push(dir);
  const path = join(dir, 'status.json');
  await writeFile(path, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return vi.fn(async (_path: string) => readFile(path, 'utf8'));
}
it('reports every idle lane and queued held lane, with red exit status', async () => {
  const row = (running: number, target: number, queued: number, held = false) => ({ running, target, queued, held });
  const reader = await fixture({ last_tick: TICK, lanes: {
    codex: row(1, 3, 4), local: row(0, 2, 1), held: row(3, 2, 5, true),
    full: row(2, 2, 3), over: row(3, 2, 1), empty: row(0, 2, 0), heldEmpty: row(0, 2, 0, true),
  } });
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await cmdFleetIdleLanes(['--json'], reader)).toBe(1);
  expect(reader.mock.calls[0]![0]).toMatch(/\.ashlr-runs\/queue\/status.json$/);
  expect(JSON.parse(output.mock.calls[0]![0]).lanes).toEqual([
    { lane: 'codex', status: 'red', running: 1, target: 3, queued: 4 },
    { lane: 'local', status: 'red', running: 0, target: 2, queued: 1 },
    { lane: 'held', status: 'warn', running: 3, target: 2, queued: 5 },
  ]);
});
it('warns without failing for held work and prints plain words', async () => {
  const reader = await fixture({ last_tick: TICK, lanes: { held: { running: 0, target: 2, queued: 3, held: true } } });
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await cmdFleetIdleLanes([], reader)).toBe(0);
  expect(output).toHaveBeenCalledWith('warn: held: 0/2 running, 3 queued');
});
it.each([
  { paused: 'disk guard' },
  { admission: { decision: 'stop' } },
  { admission: { cap: 4, running: 4 } },
])('suppresses red and preserves held warnings during a fleet-wide block (%j)', async block => {
  const tick = new Date(NOW - 60_000).toISOString();
  const lanes = {
    codex: { running: 1, target: 3, queued: 4, held: false },
    local: { running: 0, target: 2, queued: 3, held: true },
  };
  const reader = await fixture({ last_tick: tick, lanes, paused: block.paused,
    admission: block.admission && { ts: tick, ...block.admission } });
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await cmdFleetIdleLanes(['--json'], reader)).toBe(0);
  expect(JSON.parse(output.mock.calls[0]![0]).lanes).toEqual([
    { lane: 'local', status: 'warn', running: 0, target: 2, queued: 3 },
  ]);
});

it('keeps the lane-local verdict when a stop belongs to another tick', async () => {
  const reader = await fixture({ last_tick: '2026-11-02T12:00:30Z',
    admission: { ts: '2026-11-02T12:00:00Z', decision: 'stop' },
    lanes: { codex: { running: 1, target: 3, queued: 4, held: false } } });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await cmdFleetIdleLanes(['--json'], reader)).toBe(1);
});
it('accepts an empty fleet and rejects invalid input without echoing its contents', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await cmdFleetIdleLanes([], await fixture({ last_tick: TICK, lanes: {} }))).toBe(0);
  for (const contents of ['private malformed data', {}, { lanes: [] }, { last_tick: TICK, lanes: { bad: { held: false, running: -1, target: 2, queued: 1 } } }]) {
    expect(await cmdFleetIdleLanes(['--json'], await fixture(contents))).toBe(2);
    expect(JSON.parse(output.mock.calls.at(-1)![0]).error).toContain('Cannot read lane status');
  }
  expect(await cmdFleetIdleLanes(['--json'], async () => { throw new Error('private'); })).toBe(2);
});
it.each([
  ['missing', undefined],
  ['invalid', 'invalid date'],
  ['stale', new Date(NOW - 60_001).toISOString()],
  ['future', new Date(NOW + 1).toISOString()],
])('returns an error before reading the ledger for a %s dispatcher tick', async (_label, tick) => {
  const reader = await fixture({ last_tick: tick,
    lanes: { codex: { running: 0, target: 2, queued: 3, held: false } } });
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await cmdFleetIdleLanes(['--json'], reader)).toBe(2);
  expect(JSON.parse(output.mock.calls[0]![0])).toEqual({
    schema: 'fleet.idle-lanes.v1',
    error: expect.stringContaining('last_tick'),
  });
  expect(reader).toHaveBeenCalledTimes(1);
});
it('handles help and rejects unknown or duplicate flags without reading status', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const reader = vi.fn();
  expect(await cmdFleetIdleLanes(['--help'], reader)).toBe(0);
  expect(await cmdFleetIdleLanes(['--bad'], reader)).toBe(2);
  expect(await cmdFleetIdleLanes(['--json', '--json'], reader)).toBe(2);
  expect(reader).not.toHaveBeenCalled();
});

it('loads idle-lanes through the generated fleet registry', async () => {
  const module = await FLEET_SUBCOMMAND_LOADERS['idle-lanes']!();
  expect(module.cmdFleetIdleLanes).toBe(cmdFleetIdleLanes);
});
