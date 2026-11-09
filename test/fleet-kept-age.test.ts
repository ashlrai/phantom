import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetKeptAge, readFleetKeptAge } from '../src/cli/fleet-kept-age.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

let root: string;
let runs: string;
let wt: string;
const now = Date.UTC(2026, 10, 6);
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kept-age-'));
  runs = join(root, 'runs'); wt = join(root, 'worktrees');
  await mkdir(join(runs, 'queue'), { recursive: true });
  await mkdir(wt);
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
async function status(ids: string[]) { await writeFile(join(runs, 'queue/status.json'), JSON.stringify({ kept_worktrees: ids })); }
async function marker(id: string, hours: number) {
  const path = join(runs, `${id}.base`);
  await writeFile(path, '');
  const time = new Date(now - hours * 3_600_000);
  await utimes(path, time, time);
}

it('sorts marker ages and counts boundary bands, duplicates and unknown evidence', async () => {
  await status(['new', 'old', 'six', 'day', 'missing', 'future', 'old']);
  await Promise.all([marker('new', 1), marker('old', 25), marker('six', 6), marker('day', 24), marker('future', -1)]);
  await mkdir(join(wt, 'old'));
  const report = await readFleetKeptAge({ runsDir: runs, wtDir: wt, now });
  expect(report.worktrees).toEqual([
    { id: 'old', ageHours: 25, exists: true }, { id: 'day', ageHours: 24, exists: false },
    { id: 'six', ageHours: 6, exists: false }, { id: 'new', ageHours: 1, exists: false },
    { id: 'future', ageHours: null, exists: false }, { id: 'missing', ageHours: null, exists: false },
  ]);
  expect(report.totals).toEqual({ under6h: 1, from6to24h: 2, over24h: 1, unknown: 2 });
});

it('honors root overrides and renders JSON and plain output', async () => {
  await status(['one']); await marker('one', 2);
  vi.stubEnv('ASHLR_RUNS_DIR', runs); vi.stubEnv('ASHLR_WT_DIR', wt);
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await cmdFleetKeptAge(['--json'], { now })).toBe(0);
  expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ schema: 'fleet.kept-age.v1', worktrees: [{ id: 'one', ageHours: 2, exists: false }] });
  expect(await cmdFleetKeptAge([], { now })).toBe(0);
  expect(log.mock.calls[1]![0]).toContain('one: 2.0 hours; worktree missing');
  expect(await FLEET_SUBCOMMAND_LOADERS['kept-age']!()).toHaveProperty('cmdFleetKeptAge');
});

it('handles empty and invalid status and rejects unsafe IDs and arguments', async () => {
  await status([]);
  expect((await readFleetKeptAge({ runsDir: runs, wtDir: wt })).worktrees).toEqual([]);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  for (const text of ['broken', '{}', '{"kept_worktrees":["../escape"]}']) {
    await writeFile(join(runs, 'queue/status.json'), text);
    expect(await cmdFleetKeptAge(['--json'], { runsDir: runs, wtDir: wt })).toBe(1);
  }
  expect(await cmdFleetKeptAge(['--bad'])).toBe(2);
});
