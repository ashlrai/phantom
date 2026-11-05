import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetDiskSweep, type FleetDiskSweepDeps } from '../src/cli/fleet-disk-sweep.js';

let root: string;
const deps: FleetDiskSweepDeps = {
  now: () => Date.parse('2026-11-04T00:00:00Z'), freeGb: async () => 40,
  freezeBelowGb: async () => 60, wtCache: async () => ({ code: 0, freedGb: 2 }),
  worktreeStale: async () => ({ code: 1, freedGb: 1 }),
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'disk-sweep-'));
  vi.stubEnv('ASHLR_RUNS_DIR', root);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

describe('disk sweep log and history', () => {
  it('appends each result, including failed runs, to the configured root', async () => {
    expect(await cmdFleetDiskSweep(['--log', '--apply'], deps)).toBe(1);
    expect(await cmdFleetDiskSweep(['--log'], { ...deps, freeGb: async () => 100 })).toBe(0);
    const lines = (await readFile(join(root, 'queue', 'disk-sweep.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ generatedAt: '2026-11-04T00:00:00.000Z', apply: true, freeGb: 40, swept: true, freedGb: 3, steps: [
      { name: 'wt-cache', ran: true, code: 0, freedGb: 2 }, { name: 'worktree-stale', ran: true, code: 1, freedGb: 1 },
    ] });
    expect(lines[1]).toMatchObject({ apply: false, swept: false, freedGb: 0 });
  });

  it('shows the last entries in plain lines or as a JSON array without sweeping', async () => {
    for (let i = 0; i < 12; i++) await cmdFleetDiskSweep(['--log'], { ...deps, now: () => i * 1000 });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const freeGb = vi.fn(async () => 1);
    expect(await cmdFleetDiskSweep(['--history'], { freeGb })).toBe(0);
    expect(String(write.mock.calls[0]![0]).trim().split('\n')).toHaveLength(10);
    write.mockClear();
    expect(await cmdFleetDiskSweep(['--history', '2', '--json'], { freeGb })).toBe(0);
    const entries = JSON.parse(String(write.mock.calls[0]![0]));
    expect(entries.map((entry: { generatedAt: string }) => entry.generatedAt)).toEqual(['1970-01-01T00:00:10.000Z', '1970-01-01T00:00:11.000Z']);
    expect(freeGb).not.toHaveBeenCalled();
  });

  it('handles missing history, invalid options and inaccessible logs', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await cmdFleetDiskSweep(['--history', '--json'], deps)).toBe(0);
    expect(String(write.mock.calls[0]![0])).toBe('[]\n');
    for (const args of [['--history', '0'], ['--history', '-1'], ['--history', '--apply'], ['--log', '--log']]) {
      expect(await cmdFleetDiskSweep(args, deps)).toBe(2);
    }
    await writeFile(join(root, 'queue'), 'not a directory');
    expect(await cmdFleetDiskSweep(['--log'], deps)).toBe(1);
    expect(await cmdFleetDiskSweep(['--history'], deps)).toBe(1);
  });
});
