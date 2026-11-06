/**
 * RQ-PHX-SCHEDULELOADREPEAT02SOLB1 — repeating `--write --load` while the
 * self-tick launchd job is already loaded must succeed instead of dying on a
 * second bootstrap. Before activating, the verb probes `launchctl print
 * gui/<uid>/<label>` through the same argv-only spawn seam: loaded + unchanged
 * reports already-loaded and skips the bootstrap, loaded + changed exits
 * nonzero saying a reload is required (it never unloads or restarts the
 * service), and not-loaded bootstraps normally with failures still propagated.
 * Everything runs against a temp HOME and a fake spawn; the host's launchctl
 * and the real ~/Library are never touched.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cmdFleetSelfTickSchedule } from '../src/cli/fleet-self-tick-schedule.js';
import { SELF_TICK_LABEL } from '../src/core/fleet/self-tick-schedule.js';

/** `launchctl print` exits nonzero for a label that is not loaded. */
const ABSENT = 113;

describe('fleet self-tick-schedule repeat load (RQ-PHX-SCHEDULELOADREPEAT02SOLB1)', () => {
  let home: string;
  let out: string[];
  let err: string[];
  let spawnCalls: string[][];
  let loaded: boolean;
  let activateStatus: number;
  const probeTarget = expect.stringMatching(new RegExp(`^gui/\\d+/${SELF_TICK_LABEL.replace(/\./g, '\\.')}$`));
  const spawn = (argv: readonly string[]) => {
    spawnCalls.push([...argv]);
    if (argv[0] === 'launchctl' && argv[1] === 'print') return { status: loaded ? 0 : ABSENT };
    return { status: activateStatus };
  };
  const run = (args: string[], deps: Parameters<typeof cmdFleetSelfTickSchedule>[1] = {}) =>
    cmdFleetSelfTickSchedule(args, {
      home, platform: 'darwin', spawn,
      output: (text) => out.push(text),
      error: (text) => err.push(text),
      ...deps,
    });
  const plist = () => join(home, 'Library', 'LaunchAgents', `${SELF_TICK_LABEL}.plist`);
  const bootstrapArgv = () => ['launchctl', 'bootstrap', expect.stringMatching(/^gui\/\d+$/), plist()];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'self-tick-repeat-load-'));
    out = []; err = []; spawnCalls = []; loaded = false; activateStatus = 0;
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('a repeated install with the label loaded and the plist unchanged reports already-loaded and never re-bootstraps', async () => {
    expect(await run(['--write', '--load'])).toBe(0);
    expect(spawnCalls).toEqual([
      ['launchctl', 'print', probeTarget],
      bootstrapArgv(),
    ]);

    loaded = true;
    spawnCalls = [];
    expect(await run(['--write', '--load'])).toBe(0);
    expect(spawnCalls).toEqual([['launchctl', 'print', probeTarget]]);
    expect(out.join('\n')).toContain('INSTALLED + LOADED');
    expect(out.join('\n')).toContain(`${plist()}  unchanged`);
    expect(out.join('\n')).toContain('activation: already-loaded');
  });

  it('the JSON report carries the explicit activation state for a repeated install', async () => {
    expect(await run(['--write', '--load', '--json'])).toBe(0);
    loaded = true;
    expect(await run(['--write', '--load', '--json'])).toBe(0);
    const report = JSON.parse(out.at(-1)!) as {
      loaded: boolean;
      units: { path: string; state: string; activate: string[]; activation?: string }[];
    };
    expect(report.loaded).toBe(true);
    expect(report.units).toHaveLength(1);
    expect(report.units[0]).toMatchObject({ path: plist(), state: 'unchanged', activation: 'already-loaded' });
    expect(report.units[0]!.activate.slice(0, 2)).toEqual(['launchctl', 'bootstrap']);
  });

  it('a fresh install against an unloaded label probes first and bootstraps exactly once', async () => {
    expect(await run(['--write', '--load'])).toBe(0);
    expect(spawnCalls).toEqual([
      ['launchctl', 'print', probeTarget],
      bootstrapArgv(),
    ]);
    expect(out.join('\n')).toContain('activation: activated');
  });

  it('a changed plist while the label is loaded exits nonzero requiring a reload, without unloading or restarting anything', async () => {
    expect(await run(['--write', '--load'])).toBe(0);
    loaded = true;
    spawnCalls = [];
    expect(await run(['--write', '--load', '--interval', '600'])).toBe(1);
    expect(err.join('\n')).toContain('reload is required');
    expect(err.join('\n')).toContain(plist());
    // The new definition was written but nothing was bootstrapped, booted out,
    // kicked or enabled: only the probe ran.
    expect(spawnCalls).toEqual([['launchctl', 'print', probeTarget]]);
    expect(readFileSync(plist(), 'utf8')).toContain('<key>StartInterval</key><integer>600</integer>');
  });

  it('a failed bootstrap on an unloaded label still exits nonzero and names the manual command', async () => {
    activateStatus = 5;
    expect(await run(['--write', '--load'])).toBe(1);
    expect(spawnCalls).toEqual([
      ['launchctl', 'print', probeTarget],
      bootstrapArgv(),
    ]);
    expect(err.join('\n')).toContain('Activation failed');
    expect(err.join('\n')).toContain('launchctl');
  });

  it('a probe that cannot run still falls through to a bootstrap whose failure propagates', async () => {
    const flaky = (argv: readonly string[]) => {
      spawnCalls.push([...argv]);
      if (argv[0] === 'launchctl' && argv[1] === 'print') return { status: null, error: new Error('spawn ETIMEDOUT') };
      return { status: activateStatus };
    };
    activateStatus = 5;
    expect(await run(['--write', '--load'], { spawn: flaky })).toBe(1);
    expect(spawnCalls).toEqual([
      ['launchctl', 'print', probeTarget],
      bootstrapArgv(),
    ]);
    expect(err.join('\n')).toContain('Activation failed');
  });

  it('preview makes zero process calls and writes nothing', async () => {
    expect(await run([])).toBe(0);
    expect(await run(['--json'])).toBe(0);
    expect(await run(['--load'])).toBe(2);
    expect(existsSync(plist())).toBe(false);
    expect(spawnCalls).toEqual([]);
  });

  it('linux: unchanged units still activate each unit argv in order with no launchd probe', async () => {
    expect(await run(['--write', '--load'], { platform: 'linux' })).toBe(0);
    expect(await run(['--write', '--load'], { platform: 'linux' })).toBe(0);
    const dir = join(home, '.config', 'systemd', 'user');
    expect(readFileSync(join(dir, 'phm-self-tick.timer'), 'utf8')).toContain('OnUnitActiveSec=900s');
    expect(spawnCalls).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', 'phm-self-tick.timer'],
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', 'phm-self-tick.timer'],
    ]);
  });
});
