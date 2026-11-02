import { lstat, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFleetMainHealth } from '../src/core/fleet/main-health.js';
import { parseSwitchAction, readRunsSwitches, setRunsSwitch } from '../src/core/fleet/runs-switches.js';

let runsDir: string;
beforeEach(async () => { runsDir = await mkdtemp(join(tmpdir(), 'runs-switches-guardian-')); });
afterEach(async () => { await rm(runsDir, { recursive: true, force: true }); });

const row = (state: { switches: { id: string; on: boolean; since: string | null }[] }) =>
  state.switches.find((entry) => entry.id === 'MAIN_GUARDIAN_OFF');

describe('MAIN_GUARDIAN_OFF runs switch', () => {
  it('reads off when absent and on with since when queue/MAIN_GUARDIAN_OFF exists', async () => {
    assert.equal(row(await readRunsSwitches({ runsDir }))?.on, false);
    await mkdir(join(runsDir, 'queue'));
    await writeFile(join(runsDir, 'queue', 'MAIN_GUARDIAN_OFF'), '');
    const state = await readRunsSwitches({ runsDir });
    assert.equal(row(state)?.on, true);
    assert.equal(typeof row(state)?.since, 'string');
  });

  it('drives the real guardian flag: set creates queue/ 0o700 and file 0o600, clear removes it', async () => {
    const on = await setRunsSwitch('MAIN_GUARDIAN_OFF', true, { runsDir });
    assert.equal(on.sourceState, 'healthy');
    assert.equal(row(on)?.on, true);
    assert.equal((await lstat(join(runsDir, 'queue'))).mode & 0o777, 0o700);
    const flagPath = join(runsDir, 'queue', 'MAIN_GUARDIAN_OFF');
    assert.equal((await lstat(flagPath)).mode & 0o777, 0o600);
    assert.equal((await readFleetMainHealth({ runsDir })).guardianOff, true);
    const off = await setRunsSwitch('MAIN_GUARDIAN_OFF', false, { runsDir });
    assert.equal(off.sourceState, 'healthy');
    assert.equal(row(off)?.on, false);
    await assert.rejects(lstat(flagPath), { code: 'ENOENT' });
    assert.equal((await readFleetMainHealth({ runsDir })).guardianOff, false);
  });

  it('never unlinks a symlinked queue/MAIN_GUARDIAN_OFF and reports degraded', async () => {
    await mkdir(join(runsDir, 'queue'));
    await mkdir(join(runsDir, 'outside'));
    await writeFile(join(runsDir, 'outside', 'MAIN_GUARDIAN_OFF'), 'keep');
    await symlink(join(runsDir, 'outside', 'MAIN_GUARDIAN_OFF'), join(runsDir, 'queue', 'MAIN_GUARDIAN_OFF'));
    const state = await setRunsSwitch('MAIN_GUARDIAN_OFF', false, { runsDir });
    assert.equal(state.sourceState, 'degraded');
    assert.equal(row(state)?.on, true);
    assert.equal((await lstat(join(runsDir, 'queue', 'MAIN_GUARDIAN_OFF'))).isSymbolicLink(), true);
  });

  it('accepts the guardian id in parseSwitchAction and still rejects unknown ids', () => {
    assert.deepEqual(parseSwitchAction({ id: 'MAIN_GUARDIAN_OFF', on: true }), { id: 'MAIN_GUARDIAN_OFF', on: true });
    assert.equal(parseSwitchAction({ id: 'NOT_A_SWITCH', on: true }), null);
  });
});
