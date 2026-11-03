import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetAppEnsure } from '../src/cli/fleet-app-ensure.js';
import { cmdFleetAppsEnsure, selfCliPrefix, type AppsEnsureChildRunner } from '../src/cli/fleet-apps-ensure.js';

// Everything written to process.stdout during a test; the real-ensure adapter routes child output away from it.
let sink = '';
beforeEach(() => {
  sink = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { sink += s; return true; }) as never);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** Fake macOS app state: running apps, refused launches, and every control call made. */
function fakeMac(running: Record<string, boolean>, refuseLaunch: string[] = []) {
  const controls: Array<{ action: string; app: string }> = [];
  const exec = vi.fn(async (_file: string, argv: readonly string[]) => {
    const [action, app] = [argv[2]!, argv[3]!];
    controls.push({ action, app });
    if (action === 'status') return { stdout: JSON.stringify({ ok: true, running: running[app] === true }), stderr: '' };
    if (refuseLaunch.includes(app)) return { stdout: JSON.stringify({ ok: false, code: 'permission_denied' }), stderr: '' };
    running[app] = true;
    return { stdout: JSON.stringify({ ok: true, code: 'launched' }), stderr: '' };
  });
  return { exec, controls, launches: (app: string) => controls.filter(c => c.action === 'launch' && c.app === app).length };
}

/** Real app-ensure logic in-process over the fake exec and fake clock, answering like a child: JSON on stdout, exit code. */
function realEnsureRunner(mac: ReturnType<typeof fakeMac>, clock: { t: number }): AppsEnsureChildRunner {
  return async (args, options) => {
    const [, , app, ...flags] = args;
    sink = '';
    const code = await cmdFleetAppEnsure([app!, ...flags], {
      exec: mac.exec, locateScript: () => '/fake/app_control.py', now: () => clock.t,
      sleep: async (ms: number) => { clock.t += ms; }, signal: options.signal,
    });
    const stdout = sink;
    sink = '';
    return { code, stdout };
  };
}

/** The aggregate: exactly one JSON line on stdout. */
const report = (): Record<string, unknown> => {
  const lines = sink.split('\n').filter(line => line !== '');
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!);
};
const childReport = (app: string, outcome: string, running = true) =>
  ({ code: 0, stdout: JSON.stringify({ app, outcome, launched: outcome === 'launched', running }) });

describe('fleet apps-ensure', () => {
  it('already-running app is left alone; stopped app launches once and status confirms running', async () => {
    const clock = { t: 0 };
    const mac = fakeMac({ Cursor: true, Claude: false });
    expect(await cmdFleetAppsEnsure(['Cursor', 'Claude', '--json'], { runChild: realEnsureRunner(mac, clock), now: () => clock.t })).toBe(0);
    expect(mac.launches('Cursor')).toBe(0);
    expect(mac.launches('Claude')).toBe(1);
    expect(mac.controls.filter(c => c.app === 'Claude').map(c => c.action)).toEqual(['status', 'launch', 'status']);
    expect(report()).toEqual({
      ok: true,
      endedBy: 'complete',
      timeoutMs: 30_000,
      apps: [
        { app: 'Cursor', attempted: true, outcome: 'running', launched: false, observedRunning: true },
        { app: 'Claude', attempted: true, outcome: 'launched', launched: true, observedRunning: true },
      ],
    });
  });

  it('an ordinary app failure does not stop the batch', async () => {
    const clock = { t: 0 };
    const mac = fakeMac({ Cursor: true }, ['Claude']);
    expect(await cmdFleetAppsEnsure(['Claude', 'Cursor', '--json'], { runChild: realEnsureRunner(mac, clock), now: () => clock.t })).toBe(1);
    expect(report()).toMatchObject({
      ok: false,
      endedBy: 'complete',
      apps: [
        { app: 'Claude', attempted: true, outcome: 'launch-failed', observedRunning: false },
        { app: 'Cursor', attempted: true, outcome: 'running', observedRunning: true },
      ],
    });
  });

  it('a deadline stops the batch before the next app and lists the skipped app', async () => {
    const clock = { t: 0 };
    const runner = vi.fn<AppsEnsureChildRunner>(async (args) => {
      clock.t += 1000;
      return childReport(args[2]!, 'timeout', false);
    });
    expect(await cmdFleetAppsEnsure(['Claude', 'Cursor', '--timeout-ms', '1000', '--json'], { runChild: runner, now: () => clock.t })).toBe(1);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(report()).toMatchObject({
      endedBy: 'deadline',
      apps: [
        { app: 'Claude', attempted: true, outcome: 'timeout' },
        { app: 'Cursor', attempted: false, outcome: 'unattempted', reason: 'deadline' },
      ],
    });
  });

  it('one shared budget: each child gets the remaining time plus the forwarded root and interval', async () => {
    const clock = { t: 0 };
    const runner = vi.fn<AppsEnsureChildRunner>(async (args) => {
      clock.t += 400;
      return childReport(args[2]!, 'running');
    });
    expect(await cmdFleetAppsEnsure(['Cursor', 'Claude', '--root', '/tmp/runs', '--interval-ms', '250', '--timeout-ms', '1000', '--json'], {
      runChild: runner, now: () => clock.t,
    })).toBe(0);
    expect(runner.mock.calls.map(call => call[0])).toEqual([
      ['fleet', 'app-ensure', 'Cursor', '--timeout-ms', '1000', '--root', '/tmp/runs', '--interval-ms', '250', '--json'],
      ['fleet', 'app-ensure', 'Claude', '--timeout-ms', '600', '--root', '/tmp/runs', '--interval-ms', '250', '--json'],
    ]);
  });

  it('a child that never settles is cut at the budget and its signal is aborted', async () => {
    const signals: AbortSignal[] = [];
    const runner = vi.fn<AppsEnsureChildRunner>((_args, options) => {
      signals.push(options.signal);
      return new Promise<never>(() => {});
    });
    expect(await cmdFleetAppsEnsure(['Claude', 'Cursor', '--timeout-ms', '20', '--json'], { runChild: runner })).toBe(1);
    expect(signals[0]!.aborted).toBe(true);
    expect(report()).toMatchObject({
      endedBy: 'deadline',
      apps: [
        { app: 'Claude', attempted: true, outcome: 'timeout', observedRunning: false },
        { app: 'Cursor', attempted: false, reason: 'deadline' },
      ],
    });
  });

  it('a pre-aborted signal starts no child and reports every app as cancelled', async () => {
    const runner = vi.fn<AppsEnsureChildRunner>();
    const controller = new AbortController();
    controller.abort();
    expect(await cmdFleetAppsEnsure(['Cursor', 'Claude', '--json'], { runChild: runner, signal: controller.signal })).toBe(1);
    expect(runner).not.toHaveBeenCalled();
    expect(report()).toMatchObject({
      endedBy: 'cancelled',
      apps: [
        { app: 'Cursor', attempted: false, reason: 'cancelled' },
        { app: 'Claude', attempted: false, reason: 'cancelled' },
      ],
    });
  });

  it('an abort during a child stops the batch and skips the rest', async () => {
    const controller = new AbortController();
    const runner = vi.fn<AppsEnsureChildRunner>(async () => {
      controller.abort();
      return { code: null, stdout: '' };
    });
    expect(await cmdFleetAppsEnsure(['Cursor', 'Claude', '--json'], { runChild: runner, signal: controller.signal })).toBe(1);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(report()).toMatchObject({
      endedBy: 'cancelled',
      apps: [
        { app: 'Cursor', attempted: true, outcome: 'cancelled', observedRunning: false },
        { app: 'Claude', attempted: false, reason: 'cancelled' },
      ],
    });
  });

  it('duplicate app names run once, keeping the first position', async () => {
    const runner = vi.fn<AppsEnsureChildRunner>(async (args) => childReport(args[2]!, 'running'));
    expect(await cmdFleetAppsEnsure(['Cursor', 'Claude', 'Cursor', '--json'], { runChild: runner })).toBe(0);
    expect(runner.mock.calls.map(call => call[0][2])).toEqual(['Cursor', 'Claude']);
    expect(report().apps).toMatchObject([{ app: 'Cursor' }, { app: 'Claude' }]);
  });

  it('any invalid name or flag, even after valid apps, starts no control operation', async () => {
    const cases = [
      ['Cursor', 'Bogus', '--json'], ['Cursor', 'Docker'], ['Cursor', '--automatic'], ['Cursor', '--json', '--json'],
      ['Cursor', '--root'], ['Cursor', '--root', '--json'], ['Cursor', '--timeout-ms', '0'], ['Cursor', '--timeout-ms', '300001'],
      ['Cursor', '--timeout-ms', '1.5'], ['Cursor', '--interval-ms', '-5'], ['--json'], [],
    ];
    for (const args of cases) {
      const runner = vi.fn<AppsEnsureChildRunner>();
      expect(await cmdFleetAppsEnsure(args, { runChild: runner }), JSON.stringify(args)).toBe(2);
      expect(runner, JSON.stringify(args)).not.toHaveBeenCalled();
    }
    // The maximum is a valid boundary, not a rejection.
    expect(await cmdFleetAppsEnsure(['Cursor', '--timeout-ms', '300000'], { runChild: async (args) => childReport(args[2]!, 'running') })).toBe(0);
  });

  it('JSON is one aggregate; child noise on stdout is never counted or printed', async () => {
    const runner: AppsEnsureChildRunner = async (args) => ({ code: 0, stdout: `NOISE-LINE\n${childReport(args[2]!, 'running').stdout}\n` });
    expect(await cmdFleetAppsEnsure(['Cursor', '--json'], { runChild: runner })).toBe(1);
    expect(sink).not.toContain('NOISE-LINE');
    expect(report()).toMatchObject({ ok: false, apps: [{ app: 'Cursor', outcome: 'unavailable', observedRunning: false }] });
  });

  it('a throwing child is unavailable; a report for another app or a nonzero exit is not running', async () => {
    const runner = vi.fn<AppsEnsureChildRunner>(async (args) => {
      if (args[2] === 'Claude') throw new Error('spawn exploded');
      return { code: 1, stdout: JSON.stringify({ app: 'Cursor', outcome: 'running', launched: false, running: true }) };
    });
    expect(await cmdFleetAppsEnsure(['Claude', 'Cursor', '--json'], { runChild: runner })).toBe(1);
    expect(report()).toMatchObject({
      apps: [
        { app: 'Claude', outcome: 'unavailable', observedRunning: false },
        { app: 'Cursor', outcome: 'running', observedRunning: false },
      ],
    });
  });

  it('human output: one line per app, no JSON; help runs nothing', async () => {
    const runner = vi.fn<AppsEnsureChildRunner>(async (args) => childReport(args[2]!, 'running'));
    expect(await cmdFleetAppsEnsure(['Cursor', 'Claude'], { runChild: runner })).toBe(0);
    expect(vi.mocked(console.log).mock.calls.map(c => c[0])).toEqual(['Cursor: running', 'Claude: running']);
    expect(sink).toBe('');
    expect(await cmdFleetAppsEnsure(['--help'], { runChild: runner })).toBe(0);
    expect(runner).toHaveBeenCalledTimes(2);
  });
});

describe('selfCliPrefix', () => {
  it('execArgv plus the entry file; no entry is packaged; untrusted entries are null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'apps-ensure-'));
    const entry = join(dir, 'index.js');
    writeFileSync(entry, '');
    expect(selfCliPrefix(['/usr/bin/node'], ['--import', 'x'])).toEqual([]);
    expect(selfCliPrefix(['node', entry], ['--import', 'x'])).toEqual(['--import', 'x', entry]);
    expect(['relative/index.js', dir, join(dir, 'missing.js')].map(e => selfCliPrefix(['node', e]))).toEqual([null, null, null]);
    rmSync(dir, { recursive: true, force: true });
  });
});
