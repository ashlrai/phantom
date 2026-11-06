/**
 * RQ-PHX-SCHEDULECHECKACTION02SOLB2 — `ashlr fleet self-tick-check` returns a
 * machine-readable exit verdict on whether the self-tick timer is installed
 * and confirmed active by the service manager, so an agent can invoke the
 * suggested installer when absent instead of trusting queued state. Runs
 * against a temp HOME and a fake argv probe: no real launchctl/systemctl call
 * is made and nothing is written.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cmdFleetSelfTickCheck } from '../src/cli/fleet-self-tick-check.js';
import {
  SELF_TICK_INSTALL_ARGV, SELF_TICK_LAST_STALE_SECONDS, type SelfTickCheckProbeResult,
} from '../src/core/fleet/self-tick-check.js';
import { SELF_TICK_LABEL } from '../src/core/fleet/self-tick-schedule.js';
import { writeSelfTickLast } from '../src/core/fleet/self-tick-last.js';

const NOW_MS = Date.parse('2026-11-02T12:00:00Z');
const UID = 501;
let home: string, out: string[], err: string[], probeCalls: string[][];

const plist = () => join(home, 'Library', 'LaunchAgents', `${SELF_TICK_LABEL}.plist`);
const systemdDir = () => join(home, '.config', 'systemd', 'user');
const writeUnit = (path: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, 'unit'); };
const install = (p: NodeJS.Platform) => p === 'darwin' ? writeUnit(plist())
  : ['phm-self-tick.service', 'phm-self-tick.timer'].forEach((u) => writeUnit(join(systemdDir(), u)));
type Answer = (argv: readonly string[]) => SelfTickCheckProbeResult;
const run = (args: string[], platform: NodeJS.Platform, answer: Answer) => cmdFleetSelfTickCheck(args, {
  home, platform, uid: UID, now: () => NOW_MS,
  probe: (argv) => { probeCalls.push([...argv]); return answer(argv); },
  output: (text) => out.push(text), error: (text) => err.push(text),
});
const loaded: Answer = () => ({ ok: true, stdout: 'x = {}' });
const absent: Answer = () => ({ ok: false, stderr: 'Could not find specified service' });
const dead: Answer = () => ({ ok: false, stderr: 'spawn probe ENOENT' });
const systemd = (en: string, enOk: boolean, act: string, actOk: boolean): Answer =>
  (argv) => argv.includes('is-enabled') ? { ok: enOk, stdout: `${en}\n` } : { ok: actOk, stdout: `${act}\n` };
const json = () => JSON.parse(out.at(-1)!) as {
  verdict: string; installed: boolean; supported: boolean; exitCode: number;
  manager: { state: string; target: string } | null; units: { state: string }[];
  suggestedInstall: string[] | null; lastRun: { state: string; ageSeconds?: number } | null;
};
const record = (runsDir: string, at: string) => writeSelfTickLast(runsDir, {
  v: 1, at, mode: 'dry-run', state: 'ran',
  steps: [{ step: 'reset-release', state: 'ok', exitCode: 0, report: null }],
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'self-tick-check-'));
  out = []; err = []; probeCalls = [];
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('fleet self-tick-check (macOS)', () => {
  it('installed + launchctl print ok exits 0, verdict active', async () => {
    install('darwin');
    expect(await run(['--json'], 'darwin', loaded)).toBe(0);
    const report = json();
    expect(report).toMatchObject({ verdict: 'active', installed: true, supported: true, exitCode: 0 });
    expect(report.manager).toMatchObject({ state: 'loaded', target: `gui/${UID}/${SELF_TICK_LABEL}` });
    expect(report.units[0]!.state).toBe('present');
    expect(report.suggestedInstall).toBeNull();
    expect(probeCalls).toEqual([['launchctl', 'print', `gui/${UID}/${SELF_TICK_LABEL}`]]);
  });

  it.each<[string, boolean, Answer, number, string, string]>([
    ['absent definition despite loaded label', false, loaded, 1, 'missing', 'loaded'],
    ['installed plist but unloaded label', true, absent, 1, 'inactive', 'not-loaded'],
    ['nothing installed or loaded', false, absent, 1, 'missing', 'not-loaded'],
    ['probe cannot run', true, dead, 3, 'unknown', 'probe-failed'],
  ])('%s is distinct', async (_name, files, answer, code, verdict, managerState) => {
    if (files) install('darwin');
    expect(await run(['--json'], 'darwin', answer)).toBe(code);
    const report = json();
    expect(report).toMatchObject({ verdict, installed: files, exitCode: code });
    expect(report.manager!.state).toBe(managerState);
    // The installer is only ever suggested for missing/inactive, never unknown.
    expect(report.suggestedInstall).toEqual(code === 1 ? SELF_TICK_INSTALL_ARGV : null);
  });

  it('an unreadable unit path is unknown (exit 3)', async () => {
    mkdirSync(dirname(plist()), { recursive: true });
    symlinkSync(plist(), plist()); // self-referential link: statSync throws ELOOP
    expect(await run(['--json'], 'darwin', loaded)).toBe(3);
    expect(json()).toMatchObject({ verdict: 'unknown', installed: false });
  });
});

describe('fleet self-tick-check (linux)', () => {
  it.each<[string, Answer, number, string, string]>([
    ['enabled + active', systemd('enabled', true, 'active', true), 0, 'active', 'enabled-active'],
    ['disabled', systemd('disabled', false, 'inactive', false), 1, 'inactive', 'disabled'],
    ['enabled but inactive', systemd('enabled', true, 'inactive', false), 1, 'inactive', 'enabled-inactive'],
    ['not-found with files on disk', systemd('not-found', false, 'inactive', false), 1, 'inactive', 'not-found'],
    ['probe cannot run', dead, 3, 'unknown', 'probe-failed'],
  ])('%s', async (_name, answer, code, verdict, managerState) => {
    install('linux');
    expect(await run(['--json'], 'linux', answer)).toBe(code);
    const report = json();
    expect(report).toMatchObject({ verdict, installed: true });
    expect(report.manager).toMatchObject({ state: managerState, target: 'phm-self-tick.timer' });
    expect(report.suggestedInstall).toEqual(code === 1 ? SELF_TICK_INSTALL_ARGV : null);
  });

  it('the two bounded probes and missing files → missing verdict', async () => {
    install('linux');
    expect(await run(['--json'], 'linux', systemd('enabled', true, 'active', true))).toBe(0);
    expect(probeCalls).toEqual([['systemctl', '--user', 'is-enabled', 'phm-self-tick.timer'],
      ['systemctl', '--user', 'is-active', 'phm-self-tick.timer']]);
    rmSync(systemdDir(), { recursive: true, force: true });
    expect(await run(['--json'], 'linux', systemd('not-found', false, 'inactive', false))).toBe(1);
    expect(json()).toMatchObject({ verdict: 'missing', installed: false });
  });
});

describe('fleet self-tick-check last run and guards', () => {
  it('missing, fresh and stale history stay separate from the timer verdict', async () => {
    install('darwin');
    const runsDir = join(home, 'runs');
    const check = async () => { expect(await run(['--json', '--runs-dir', runsDir], 'darwin', loaded)).toBe(0); return json(); };
    expect((await check())).toMatchObject({ verdict: 'active', exitCode: 0 });
    expect((await check()).lastRun).toEqual({ state: 'missing' });
    record(runsDir, new Date(NOW_MS - 600_000).toISOString());
    expect((await check()).lastRun).toMatchObject({ state: 'fresh', ageSeconds: 600 });
    record(runsDir, new Date(NOW_MS - (SELF_TICK_LAST_STALE_SECONDS + 60) * 1000).toISOString());
    const report = await check();
    expect(report.lastRun).toMatchObject({ state: 'stale', ageSeconds: SELF_TICK_LAST_STALE_SECONDS + 60 });
    expect(report.verdict).toBe('active'); // timer truth and history truth stay separate
  });

  it('guards: --help 0, unsupported platform 3, invalid args 2 — none probe or touch fs', async () => {
    expect(await run(['--help'], 'darwin', loaded)).toBe(0);
    expect(out.join('\n')).toContain('Usage: ashlr fleet self-tick-check');
    expect(await run(['--json'], 'freebsd', loaded)).toBe(3);
    expect(json()).toMatchObject({ verdict: 'unknown', supported: false, exitCode: 3 });
    expect(probeCalls).toEqual([]);
    for (const args of [
      ['--bogus'], ['positional'], ['--json', '--json'], ['--runs-dir'], ['--runs-dir', 'rel/dir'],
      ['--runs-dir', '--json'], ['--runs-dir', '/a', '--runs-dir', '/b'], ['--json=1'], ['--runs-dir=/x'],
    ]) {
      out = []; err = []; probeCalls = [];
      expect(await run(args, 'darwin', loaded), args.join(' ')).toBe(2);
      expect(err.join('\n')).toContain('Invalid arguments');
      expect(probeCalls).toEqual([]);
    }
    expect(readdirSync(home)).toEqual([]);
  });

  it('mutates nothing: no writes under home or runs-dir, probes are read-only verbs', async () => {
    install('darwin');
    const runsDir = join(home, 'runs');
    record(runsDir, new Date(NOW_MS - 60_000).toISOString());
    const before = readdirSync(home).sort(), queue = join(runsDir, 'queue');
    const beforeRuns = readdirSync(queue).sort();
    expect(await run(['--runs-dir', runsDir], 'darwin', loaded)).toBe(0);
    expect(readdirSync(home).sort()).toEqual(before);
    expect(readdirSync(queue).sort()).toEqual(beforeRuns);
    for (const argv of probeCalls) {
      expect(['launchctl', 'systemctl']).toContain(argv[0]!);
      expect(['print', 'is-enabled', 'is-active']).toContain(argv[1] === '--user' ? argv[2]! : argv[1]!);
    }
    expect(out.join('\n')).toContain('ACTIVE');
    expect(out.join('\n')).toContain('last run');
  });
});
