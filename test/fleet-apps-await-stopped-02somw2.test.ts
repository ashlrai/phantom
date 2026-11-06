import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetAppsAwait, type FleetAppsAwaitDeps } from '../src/cli/fleet-apps-await.js';
import type { FleetAppExec } from '../src/cli/fleet-app.js';

/** Reply wrapper: wraps running state in a valid status JSON object. */
const reply = (running: boolean | null) => ({
  stdout: JSON.stringify({ ok: true, running, host: '/fake/private-host' }),
  stderr: 'private diagnostic',
});
let output: string;
let dirs: string[];

beforeEach(() => {
  output = '';
  dirs = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  dirs.forEach(dir => rmSync(dir, { recursive: true, force: true }));
});

const view = () => JSON.parse(output) as { outcome: string; target?: string; elapsedMs: number; apps: Array<{ app: string; running: boolean | null }> };

const deps = (exec: FleetAppExec): FleetAppsAwaitDeps => ({
  exec,
  locateScript: () => '/fake/app_control.py',
});

describe('fleet apps-await stopped target', () => {
  it('reports ready when all apps are already stopped (single round)', async () => {
    const args = ['--apps', 'Codex,Claude', '--timeout-ms', '300', '--interval-ms', '100', '--target', 'stopped', '--json'];
    const exec = vi.fn<FleetAppExec>(async () => reply(false));
    expect(await cmdFleetAppsAwait(args, deps(exec))).toBe(0);
    expect(view().outcome).toBe('ready');
    expect(view().target).toBe('stopped');
    expect(view().apps).toEqual([
      { app: 'Codex', running: false },
      { app: 'Claude', running: false },
    ]);
  });

  it('transitions two named apps to stopped and reports ready once both confirm false', async () => {
    const args = ['--apps', 'Codex,Claude', '--timeout-ms', '1000', '--interval-ms', '100', '--target', 'stopped', '--json'];
    let time = 0;
    let calls = 0;
    // First 8 calls return true (rounds 1-4), then false (round 5 both stopped).
    // Round 1: calls 0,1 → true → probe null  | Round 3: calls 4,5 → true → probe null
    // Round 2: calls 2,3 → true → probe null  | Round 4: calls 6,7 → true → probe null
    // Round 5: calls 8,9 → false → probe true  → reached (exit 0)
    const exec = vi.fn<FleetAppExec>(async () => reply(calls++ < 8));
    const result = await cmdFleetAppsAwait(args, { ...deps(exec), now: () => time, sleep: async ms => { time += ms; } });
    expect(result).toBe(0);
    expect(view().outcome).toBe('ready');
    expect(view().target).toBe('stopped');
    expect(view().apps).toEqual([
      { app: 'Codex', running: false },
      { app: 'Claude', running: false },
    ]);
  });

  it('returns timeout when one app reports false and the other null at the deadline', async () => {
    const args = ['--apps', 'Codex,Claude', '--timeout-ms', '300', '--interval-ms', '100', '--target', 'stopped', '--json'];
    let time = 0;
    const exec: FleetAppExec = async (_file, argv) =>
      reply(argv[3] === 'Codex' ? false : null);
    const result = await cmdFleetAppsAwait(args, { ...deps(exec), now: () => time, sleep: async ms => { time += ms; } });
    expect(result).toBe(3);
    expect(view().outcome).toBe('timeout');
    expect(view().target).toBe('stopped');
    expect(view().apps.map(row => row.running)).toEqual([false, null]);
  });

  it('reports invalid targets before any discovery or execution', async () => {
    const exec = vi.fn<FleetAppExec>();
    const locateScript = vi.fn(() => null);
    const result = await cmdFleetAppsAwait(
      ['--apps', 'Codex', '--timeout-ms', '100', '--target', 'invalid', '--json'],
      { exec, locateScript },
    );
    expect(result).toBe(2);
    expect(exec).not.toHaveBeenCalled();
    expect(locateScript).not.toHaveBeenCalled();
  });

  it('preserves default running behavior when --target is omitted', async () => {
    const args = ['--apps', 'Codex,Claude', '--timeout-ms', '200', '--interval-ms', '100', '--json'];
    let time = 0;
    const exec: FleetAppExec = async () => reply(true);
    const result = await cmdFleetAppsAwait(args, { ...deps(exec), now: () => time, sleep: async ms => { time += ms; } });
    expect(result).toBe(0);
    expect(view().outcome).toBe('ready');
    expect(view().target).toBe('running');
  });

  it('explicit --target running matches default behavior', async () => {
    const args = ['--apps', 'Codex,Claude', '--timeout-ms', '200', '--interval-ms', '100', '--target', 'running', '--json'];
    let time = 0;
    const exec: FleetAppExec = async () => reply(true);
    const result = await cmdFleetAppsAwait(args, { ...deps(exec), now: () => time, sleep: async ms => { time += ms; } });
    expect(result).toBe(0);
    expect(view().outcome).toBe('ready');
    expect(view().target).toBe('running');
  });

  it('aborts without scheduling further children when the signal fires', async () => {
    const controller = new AbortController();
    const exec = vi.fn<FleetAppExec>(async () => { controller.abort(); return reply(null); });
    const args = ['--apps', 'Codex,Claude', '--timeout-ms', '300', '--interval-ms', '100', '--target', 'stopped', '--json'];
    const result = await cmdFleetAppsAwait(args, { ...deps(exec), signal: controller.signal });
    expect(result).toBe(1);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('bounds a hanging sleep after the deadline fires', async () => {
    vi.useFakeTimers();
    const result = cmdFleetAppsAwait(
      ['--apps', 'Codex,Claude', '--timeout-ms', '200', '--interval-ms', '100', '--target', 'stopped', '--json'],
      {
        ...deps(async () => reply(null)),
        sleep: () => new Promise(() => {}), // never resolves
      },
    );
    await vi.advanceTimersByTimeAsync(210);
    expect(await result).toBe(1);
    vi.useRealTimers();
  });

  it('reports all null (no observation) as unavailable', async () => {
    const args = ['--apps', 'Codex,Claude', '--timeout-ms', '200', '--interval-ms', '100', '--target', 'stopped', '--json'];
    let time = 0;
    const exec: FleetAppExec = async () => ({ stdout: 'garbage /fake/host', stderr: '' });
    const result = await cmdFleetAppsAwait(args, { ...deps(exec), now: () => time, sleep: async ms => { time += ms; } });
    expect(result).toBe(1);
    expect(view().outcome).toBe('unavailable');
    expect(view().apps.every(row => row.running === null)).toBe(true);
  });

  it('reports missing bridge and wholly unreadable probes as unavailable for stopped', async () => {
    const args = ['--apps', 'Codex', '--timeout-ms', '100', '--target', 'stopped', '--json'];
    const result = await cmdFleetAppsAwait(args, { locateScript: () => null, locateInstalledScript: () => null });
    expect(result).toBe(1);
  });

  it('uses installed bridge fallback beneath the explicit temporary root for stopped', async () => {
    const root = mkdtempSync(join(tmpdir(), 'apps-stopped-'));
    dirs.push(root);
    const bridge = join(root, 'mac-bridge', 'current');
    mkdirSync(bridge, { recursive: true });
    writeFileSync(join(bridge, 'app_control.py'), '# fake fixture, never executed\n');
    const args = ['--apps', 'Codex,Claude', '--timeout-ms', '300', '--interval-ms', '100', '--target', 'stopped', '--root', root, '--json'];
    const exec = vi.fn<FleetAppExec>(async () => reply(false));
    const result = await cmdFleetAppsAwait(args, { ...deps(exec), locateScript: () => null });
    expect(result).toBe(0);
    expect(view().outcome).toBe('ready');
    expect(exec.mock.calls[0]![1]).toEqual(['-I', realpathSync(join(bridge, 'app_control.py')), 'status', 'Codex', '--output-dir', root]);
    expect(output).not.toContain(root);
  });

  it.each([
    ['--target', 'invalid'],
    ['--target', ''],
    ['--target', 'RUNNING'],
    ['--target', 'STOPPED'],
    ['--target', 'bogus'],
  ])('rejects invalid --target values: %s %s', async (first, second) => {
    const exec = vi.fn<FleetAppExec>();
    const locateScript = vi.fn(() => null);
    const result = await cmdFleetAppsAwait(
      ['--apps', 'Codex', '--timeout-ms', '100', '--json', first!, second!],
      { exec, locateScript },
    );
    expect(result).toBe(2);
    expect(exec).not.toHaveBeenCalled();
    expect(locateScript).not.toHaveBeenCalled();
  });
});
