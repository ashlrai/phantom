/**
 * RQ-PHX-SELFTICKSCHEDULE02 — `ashlr fleet self-tick-schedule` previews the
 * host timer by default, installs it atomically with --write and activates it
 * with --load through an argv-only spawn seam. Everything runs against a temp
 * HOME and a fake spawn; the real ~/Library is never touched.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cmdFleetSelfTickSchedule } from '../src/cli/fleet-self-tick-schedule.js';
import { SELF_TICK_LABEL } from '../src/core/fleet/self-tick-schedule.js';

describe('fleet self-tick-schedule CLI (darwin)', () => {
  let home: string;
  let out: string[];
  let err: string[];
  let spawnCalls: readonly string[][];
  let spawnStatus: number;
  const spawn = (argv: readonly string[]) => {
    spawnCalls = [...spawnCalls, [...argv]];
    // `launchctl print` is the loaded-label probe: nonzero means not loaded.
    if (argv[0] === 'launchctl' && argv[1] === 'print') return { status: 1 };
    return { status: spawnStatus };
  };
  const run = (args: string[], deps: Parameters<typeof cmdFleetSelfTickSchedule>[1] = {}) =>
    cmdFleetSelfTickSchedule(args, {
      home, platform: 'darwin', spawn,
      output: (text) => out.push(text),
      error: (text) => err.push(text),
      ...deps,
    });
  const plist = () => join(home, 'Library', 'LaunchAgents', `${SELF_TICK_LABEL}.plist`);

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'self-tick-schedule-'));
    out = []; err = []; spawnCalls = []; spawnStatus = 0;
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('previews by default and writes nothing', async () => {
    expect(await run([])).toBe(0);
    expect(existsSync(plist())).toBe(false);
    expect(existsSync(join(home, '.ashlr'))).toBe(false);
    expect(out.join('\n')).toContain('PREVIEW');
    expect(out.join('\n')).toContain(plist());
    expect(out.join('\n')).toContain('launchctl');
    expect(spawnCalls).toEqual([]);
  });

  it('--json preview reports the unit path, state and activate argv', async () => {
    expect(await run(['--json'])).toBe(0);
    const report = JSON.parse(out[0]!) as {
      apply: boolean; intervalSeconds: number; write: boolean;
      units: { path: string; state: string; activate: string[] }[];
    };
    expect(report).toMatchObject({ apply: false, intervalSeconds: 900, write: false });
    expect(report.units).toHaveLength(1);
    expect(report.units[0]!.path).toBe(plist());
    expect(report.units[0]!.state).toBe('preview');
    expect(report.units[0]!.activate.slice(0, 2)).toEqual(['launchctl', 'bootstrap']);
    expect(report.units[0]!.activate.at(-1)).toBe(plist());
    expect(spawnCalls).toEqual([]);
  });

  it('--write writes the plist once; a second --write reports unchanged', async () => {
    expect(await run(['--write'])).toBe(0);
    const contents = readFileSync(plist(), 'utf8');
    expect(contents).toContain(SELF_TICK_LABEL);
    expect(contents).toContain('<key>StartInterval</key><integer>900</integer>');
    expect(contents).toContain('<key>RunAtLoad</key><true/>');
    expect(contents).not.toContain('--apply');
    expect(out.join('\n')).toContain(`${plist()}  written`);
    out = [];
    expect(await run(['--write'])).toBe(0);
    expect(out.join('\n')).toContain(`${plist()}  unchanged`);
    expect(readFileSync(plist(), 'utf8')).toBe(contents);
    expect(spawnCalls).toEqual([]);
  });

  it('--write rewrites only the self-tick plist when its contents drifted', async () => {
    expect(await run(['--write'])).toBe(0);
    writeFileSync(plist(), 'drifted');
    expect(await run(['--write'])).toBe(0);
    expect(readFileSync(plist(), 'utf8')).toContain(SELF_TICK_LABEL);
    expect(out.join('\n')).toContain('written');
  });

  it('--load without --write exits 2 and spawns nothing', async () => {
    expect(await run(['--load'])).toBe(2);
    expect(existsSync(plist())).toBe(false);
    expect(spawnCalls).toEqual([]);
  });

  it('--write --load probes the label then calls the launchctl bootstrap argv once', async () => {
    expect(await run(['--write', '--load'])).toBe(0);
    expect(spawnCalls).toEqual([
      ['launchctl', 'print', expect.stringMatching(new RegExp(`^gui/\\d+/${SELF_TICK_LABEL.replace(/\./g, '\\.')}$`))],
      ['launchctl', 'bootstrap', expect.stringMatching(/^gui\/\d+$/), plist()],
    ]);
    expect(out.join('\n')).toContain('INSTALLED + LOADED');
  });

  it('a failed activation exits 1 and reports the manual command', async () => {
    spawnStatus = 5;
    expect(await run(['--write', '--load'])).toBe(1);
    expect(err.join('\n')).toContain('Activation failed');
    expect(err.join('\n')).toContain('launchctl');
    expect(readFileSync(plist(), 'utf8')).toContain(SELF_TICK_LABEL);
  });

  it('--tick-apply embeds --apply in the installed tick', async () => {
    expect(await run(['--write', '--tick-apply'])).toBe(0);
    expect(readFileSync(plist(), 'utf8')).toContain('<string>--apply</string>');
  });

  it('--interval and --runs-dir reach the unit contents', async () => {
    const runsDir = join(home, 'runs');
    expect(await run(['--write', '--interval', '600', '--runs-dir', runsDir])).toBe(0);
    const contents = readFileSync(plist(), 'utf8');
    expect(contents).toContain('<key>StartInterval</key><integer>600</integer>');
    expect(contents).toContain(`<string>--runs-dir</string><string>${runsDir}</string>`);
  });

  it('--help prints usage, writes nothing and spawns nothing', async () => {
    expect(await run(['--help'])).toBe(0);
    expect(out.join('\n')).toContain('Usage: ashlr fleet self-tick-schedule');
    expect(existsSync(plist())).toBe(false);
    expect(spawnCalls).toEqual([]);
  });

  it('unknown, duplicate or malformed arguments exit 2 before any write', async () => {
    for (const args of [
      ['--bogus'], ['positional'], ['--write', '--write'], ['--json', '--json'],
      ['--load', '--load'], ['--tick-apply', '--tick-apply'], ['--write', '--load', '--load'],
      ['--interval'], ['--interval', 'abc'], ['--interval', '1.5'], ['--interval', '120'],
      ['--interval', '7200'], ['--interval', '900', '--interval', '900'],
      ['--runs-dir'], ['--runs-dir', 'relative/dir'], ['--runs-dir', '--json'],
      ['--json=1'], ['--write=true'],
    ]) {
      out = []; err = [];
      expect(await run(args), args.join(' ')).toBe(2);
    }
    expect(existsSync(plist())).toBe(false);
    expect(existsSync(join(home, '.ashlr'))).toBe(false);
    expect(spawnCalls).toEqual([]);
  });

  it('linux: --write installs both units and --load activates each in order', async () => {
    const dir = join(home, '.config', 'systemd', 'user');
    expect(await run(['--write', '--load'], { platform: 'linux' })).toBe(0);
    expect(readFileSync(join(dir, 'phm-self-tick.service'), 'utf8')).toContain('Type=oneshot');
    const timer = readFileSync(join(dir, 'phm-self-tick.timer'), 'utf8');
    expect(timer).toContain('OnBootSec=2min');
    expect(timer).toContain('OnUnitActiveSec=900s');
    expect(spawnCalls).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', 'phm-self-tick.timer'],
    ]);
  });

  it('refuses a linked schedule directory without writing', async () => {
    const outside = join(home, 'outside');
    mkdirSync(outside);
    // Link LaunchAgents -> outside; the write must refuse rather than follow it.
    const { symlinkSync } = await import('node:fs');
    mkdirSync(join(home, 'Library'));
    symlinkSync(outside, join(home, 'Library', 'LaunchAgents'));
    expect(await run(['--write'])).toBe(1);
    expect(existsSync(join(outside, `${SELF_TICK_LABEL}.plist`))).toBe(false);
    expect(spawnCalls).toEqual([]);
  });
});
