import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { cmdFleetIdleLanes } from '../src/cli/fleet-idle-lanes.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
async function fixture(contents: unknown) {
  const dir = await mkdtemp(join(tmpdir(), 'idle-lanes-'));
  dirs.push(dir);
  const path = join(dir, 'status.json');
  await writeFile(path, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return vi.fn(async (_path: string) => readFile(path, 'utf8'));
}
it('reports every idle lane and queued held lane, with red exit status', async () => {
  const row = (running: number, target: number, queued: number, held = false) => ({ running, target, queued, held });
  const reader = await fixture({ lanes: {
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
  const reader = await fixture({ lanes: { held: { running: 0, target: 2, queued: 3, held: true } } });
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await cmdFleetIdleLanes([], reader)).toBe(0);
  expect(output).toHaveBeenCalledWith('warn: held: 0/2 running, 3 queued');
});
it('accepts an empty fleet and rejects invalid input without echoing its contents', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await cmdFleetIdleLanes([], await fixture({ lanes: {} }))).toBe(0);
  for (const contents of ['private malformed data', {}, { lanes: [] }, { lanes: { bad: { held: false, running: -1, target: 2, queued: 1 } } }]) {
    expect(await cmdFleetIdleLanes(['--json'], await fixture(contents))).toBe(2);
    expect(JSON.parse(output.mock.calls.at(-1)![0]).error).toContain('Cannot read lane status');
  }
  expect(await cmdFleetIdleLanes(['--json'], async () => { throw new Error('private'); })).toBe(2);
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
