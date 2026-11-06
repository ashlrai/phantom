import { mkdtemp, rm, lstat, readFile, symlink, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { parseSwitchAction, readRunsSwitches, setRunsSwitch, type RunsSwitchId } from '../src/core/fleet/runs-switches.js';

let runsDir: string;
beforeEach(async () => { runsDir = await mkdtemp(join(tmpdir(), 'runs-switches-')); });
afterEach(async () => { await rm(runsDir, { recursive: true, force: true }); });
it('reads all off and creates, preserves, then removes an owned flag', async () => {
  expect((await readRunsSwitches({ runsDir })).switches.every((row) => !row.on)).toBe(true);
  const state = await setRunsSwitch('ORCH_OFF', true, { runsDir, now: () => new Date('2026-10-31T12:00:00Z') });
  expect(state.sourceState).toBe('healthy');
  expect(state.switches[0]).toMatchObject({ on: true, since: expect.any(String) });
  const path = join(runsDir, 'ORCH_OFF');
  expect((await lstat(path)).mode & 0o777).toBe(0o600);
  expect(await readFile(path, 'utf8')).toBe('set by Phantom desktop 2026-10-31T12:00:00.000Z\n');
  await setRunsSwitch('ORCH_OFF', true, { runsDir });
  expect((await readRunsSwitches({ runsDir })).switches[0]?.since).toBe(state.switches[0]?.since);
  expect((await setRunsSwitch('ORCH_OFF', false, { runsDir })).switches[0]?.on).toBe(false);
  await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('leaves a symlink on and refuses directories', async () => {
  await symlink(join(runsDir, 'absent'), join(runsDir, 'PAUSE'));
  const state = await setRunsSwitch('PAUSE', false, { runsDir });
  expect(state.switches.find((row) => row.id === 'PAUSE')?.on).toBe(true);
  expect((await lstat(join(runsDir, 'PAUSE'))).isSymbolicLink()).toBe(true);
  await mkdir(join(runsDir, 'HOLD'));
  await setRunsSwitch('HOLD', false, { runsDir });
  expect((await lstat(join(runsDir, 'HOLD'))).isDirectory()).toBe(true);
});
it('creates queue but never follows a queue symlink', async () => {
  expect((await setRunsSwitch('QUEUE_DISABLE', true, { runsDir })).switches[5]?.on).toBe(true);
  await rm(join(runsDir, 'queue'), { recursive: true });
  await mkdir(join(runsDir, 'outside'));
  await writeFile(join(runsDir, 'outside', 'DISABLE'), 'keep');
  await symlink(join(runsDir, 'outside'), join(runsDir, 'queue'));
  expect((await setRunsSwitch('QUEUE_DISABLE', false, { runsDir })).sourceState).toBe('degraded');
  expect(await readFile(join(runsDir, 'outside', 'DISABLE'), 'utf8')).toBe('keep');
});
it('validates actions and reports missing or invalid directories', async () => {
  for (const body of [null, [], {}, { id: '../PAUSE', on: true }, { id: 'PAUSE', on: 1 }]) expect(parseSwitchAction(body)).toBeNull();
  expect(parseSwitchAction({ id: 'PAUSE', on: false })).toEqual({ id: 'PAUSE', on: false });
  await setRunsSwitch('../escape' as RunsSwitchId, true, { runsDir });
  expect((await readRunsSwitches({ runsDir: join(runsDir, 'missing') })).sourceState).toBe('missing');
  expect((await readRunsSwitches({ runsDir: 'relative' })).sourceState).toBe('degraded');
});
