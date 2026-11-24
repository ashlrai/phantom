import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdLanes, type LanesDeps } from '../src/cli/lanes.js';
import { readLanePressure } from '../src/core/fleet/lane-memory-pressure.js';
import { readPauseState } from '../src/core/fleet/pause-state.js';

// Only the unrelated health snapshot is substituted; switches, pressure and CLI paths are real.
const snapshot: NonNullable<LanesDeps['snapshot']> = async () => ({
  snapshot: { v: 1, generatedAt: '2026-11-21T12:00:00.000Z', commit: 'fake123', lanes: [], runs: [] },
} as Awaited<ReturnType<NonNullable<LanesDeps['snapshot']>>>);
const pressure = { ps: async () => null, run: async () => null, now: () => 0 };

describe('PR #7837 original lane pause preservation', () => {
  let root: string;
  let runsDir: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pause-lane-746s-'));
    runsDir = join(root, 'runs');
    await mkdir(join(runsDir, 'queue'), { recursive: true });
    await writeFile(join(runsDir, 'queue', 'slots.json'), JSON.stringify({
      'codex-local': { target: 4, floor: 1, ceiling: 8 },
      claude: { target: 8, floor: 1, ceiling: 12 },
    }));
    const fakeHome = join(root, 'home');
    await mkdir(join(fakeHome, '.ashlr-runs'), { recursive: true });
    await writeFile(join(fakeHome, '.ashlr-runs', 'PAUSE'), 'unrelated home pause');
    vi.stubEnv('HOME', fakeHome);
    vi.stubEnv('ASHLR_RUNS_DIR', join(root, 'unrelated-env'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  async function output(args: string[], deps: LanesDeps): Promise<string[]> {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    log.mockClear();
    expect(await cmdLanes(args, deps)).toBe(0);
    return log.mock.calls.map(call => String(call[0]));
  }

  it.each([
    { name: 'missing', global: 'off', local: 'off', line: null },
    { name: 'local', global: 'off', local: 'on', line: 'Local model launches paused; cloud launches not paused by this switch: memory held' },
    { name: 'global', global: 'on', local: 'off', line: 'All launches paused: memory held' },
    { name: 'both', global: 'on', local: 'on', line: 'All launches paused: memory held' },
    { name: 'unreadable global', global: 'unknown', local: 'on', line: 'All-launches pause could not be read; launch pause state unknown' },
    { name: 'unreadable local', global: 'off', local: 'unknown', line: 'Local-models pause could not be read; local launches may be paused' },
    { name: 'empty local', global: 'off', local: 'on', line: 'Local model launches paused; cloud launches not paused by this switch' },
  ])('$name agrees across reader, real pressure and CLI JSON/text', async ({ name, global, local, line }) => {
    for (const [file, state] of [['PAUSE', global], ['PAUSE_LOCAL', local]]) {
      if (state === 'unknown') await mkdir(join(runsDir, file!));
      else if (state === 'on') await writeFile(join(runsDir, file!), name === 'empty local' ? '' : 'memory held');
    }
    const deps = { runsDir, pressure, snapshot };
    const report = await readLanePressure({ ...pressure, runsDir });
    expect(report.pause).toEqual(await readPauseState({}, runsDir));
    expect(report.pause).toMatchObject({ global: { state: global }, local: { state: local } });
    expect(report.pauseLine).toBe(line);
    const dispatch = JSON.parse((await output(['--json'], deps))[0]!);
    const cliPressure = JSON.parse((await output(['pressure', '--json'], deps))[0]!);
    const health = JSON.parse((await output(['health', '--json'], deps))[0]!);
    for (const json of [dispatch, cliPressure, health]) {
      expect(json.pause).toEqual(report.pause);
      expect(json.pauseLine).toBe(line);
    }
    expect(dispatch).toMatchObject({ schema: 'lanes.dispatchd.v1', lanes: expect.any(Array) });
    expect(cliPressure.lanes).toEqual(report.lanes);
    // Pause reporting must not alter memory decisions or imply observed worker liveness.
    expect(report.lanes.map(row => row.allowed)).toEqual([8, 4]);
    const pressureText = await output(['pressure'], deps);
    const healthText = await output(['health'], deps);
    for (const lines of [pressureText, healthText]) {
      if (line) expect(lines[0]).toBe(line);
      else expect(lines.join('\n')).not.toMatch(/launches paused|pause state unknown/);
      expect(lines.join('\n')).not.toMatch(/cloud lanes running|workers running/);
    }
    expect(pressureText).toEqual([...(line ? [line] : []), ...report.lanes.map(row => row.reason), ...report.gaps.map(gap => `Note: ${gap}`)]);
  });

  it('uses ASHLR_RUNS_DIR when no explicit directory is supplied', async () => {
    vi.stubEnv('ASHLR_RUNS_DIR', runsDir);
    await writeFile(join(runsDir, 'PAUSE_LOCAL'), 'configured directory');
    const pause = await readPauseState();
    expect(pause.global.state).toBe('off');
    expect(pause.local.state).toBe('on');
    const report = await readLanePressure(pressure);
    expect(report.pause).toEqual(pause);
    const deps = { pressure, snapshot };
    const json = JSON.parse((await output(['--json'], deps))[0]!);
    expect(json.pause).toEqual(pause);
    expect((await output(['pressure'], deps))[0]).toBe(report.pauseLine);
    expect((await output(['health'], deps))[0]).toBe(report.pauseLine);
  });

  it('honors explicit switch paths independently of the configured runs directory', async () => {
    const pausePath = join(root, 'custom-global');
    const pauseLocalPath = join(root, 'custom-local');
    await writeFile(join(runsDir, 'PAUSE'), 'ignored default');
    await writeFile(pauseLocalPath, '1795241000000 local reason; second reason');
    const deps = { runsDir, pausePath, pauseLocalPath, pressure, snapshot };
    const report = await readLanePressure({ ...pressure, ...deps });
    expect(report.pause).toMatchObject({ global: { state: 'off' }, local: {
      state: 'on', since: new Date(1795241000000).toISOString(), reasons: ['local reason', 'second reason'],
    } });
    const json = JSON.parse((await output(['--json'], deps))[0]!);
    expect(json.pause).toEqual(report.pause);
    expect((await output(['pressure'], deps))[0]).toBe(report.pauseLine);
    expect((await output(['health'], deps))[0]).toBe(report.pauseLine);
  });
});
