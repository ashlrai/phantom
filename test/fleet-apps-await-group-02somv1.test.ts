import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetAppsAwait, type FleetAppsAwaitDeps } from '../src/cli/fleet-apps-await.js';
import type { FleetAppExec } from '../src/cli/fleet-app.js';

const args = ['--apps', 'Codex, Claude', '--timeout-ms', '300', '--interval-ms', '100', '--json'];
const reply = (running: boolean | null) => ({ stdout: JSON.stringify({ ok: true, running, host: '/fake/private-host' }), stderr: 'private diagnostic' });
let output: string;
let dirs: string[];
beforeEach(() => {
  output = ''; dirs = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks(); vi.useRealTimers();
  dirs.forEach(dir => rmSync(dir, { recursive: true, force: true }));
});
const view = () => JSON.parse(output) as { outcome: string; elapsedMs: number; apps: Array<{ app: string; running: boolean | null }> };
const deps = (exec: FleetAppExec): FleetAppsAwaitDeps => ({ exec, locateScript: () => '/fake/app_control.py' });

describe('fleet apps-await grouped readiness', () => {
  it('observes two selected apps with fixed status argv and sanitized JSON', async () => {
    const exec = vi.fn<FleetAppExec>(async () => reply(true));
    expect(await cmdFleetAppsAwait(args, deps(exec))).toBe(0);
    expect(view().outcome).toBe('ready');
    expect(view().apps).toEqual([{ app: 'Codex', running: true }, { app: 'Claude', running: true }]);
    for (const [file, argv, options] of exec.mock.calls) {
      expect(file).toBe('python3');
      expect(argv.slice(0, 3)).toEqual(['-I', '/fake/app_control.py', 'status']);
      expect(options.timeout).toBeLessThanOrEqual(300);
    }
    expect(output).not.toMatch(/private|app_control|stderr|stdout/);
  });

  it('waits for a stopped app then observes both ready in a fresh round', async () => {
    let time = 0; let calls = 0;
    const exec = vi.fn<FleetAppExec>(async () => reply(++calls !== 2));
    expect(await cmdFleetAppsAwait(args, { ...deps(exec), now: () => time, sleep: async ms => { time += ms; } })).toBe(0);
    expect(calls).toBe(4);
  });

  it('never combines ready observations from separate rounds', async () => {
    let time = 0; let calls = 0;
    const exec: FleetAppExec = async () => reply(Math.floor(calls++ / 2) % 2 === 0 ? calls % 2 === 1 : calls % 2 === 0);
    expect(await cmdFleetAppsAwait(args, { ...deps(exec), now: () => time, sleep: async ms => { time += ms; } })).toBe(3);
    expect(view().outcome).toBe('timeout');
  });

  it('preserves unknown alongside known running at the shared deadline', async () => {
    let time = 0;
    const exec: FleetAppExec = async (_file, argv) => reply(argv[3] === 'Codex' ? true : null);
    expect(await cmdFleetAppsAwait(args, { ...deps(exec), now: () => time, sleep: async ms => { time += ms; } })).toBe(3);
    expect(view().apps.map(row => row.running)).toEqual([true, null]);
    expect(view().elapsedMs).toBeGreaterThanOrEqual(300);
    expect(view().elapsedMs).toBeLessThan(310);
  });

  it('bounds hung children to two and one total deadline, consuming late rejections', async () => {
    vi.useFakeTimers();
    const rejectors: Array<(error: Error) => void> = [];
    const exec = vi.fn<FleetAppExec>(() => new Promise((_resolve, reject) => { rejectors.push(reject); }));
    const result = cmdFleetAppsAwait(['--apps', 'Codex,Claude,Cursor,Safari', '--timeout-ms', '300', '--json'], deps(exec));
    await vi.advanceTimersByTimeAsync(300);
    expect(await result).toBe(1);
    expect(exec).toHaveBeenCalledTimes(2);
    rejectors.forEach(reject => reject(new Error('fake late error')));
    await vi.advanceTimersByTimeAsync(1000);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('never exceeds two concurrent children while progressing through larger sets', async () => {
    let active = 0; let peak = 0;
    const exec: FleetAppExec = async () => {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, 1));
      active--; return reply(true);
    };
    expect(await cmdFleetAppsAwait(['--apps', 'Codex,Claude,Cursor,Safari', '--timeout-ms', '1000', '--json'], deps(exec))).toBe(0);
    expect(peak).toBe(2);
  });

  it('aborts without scheduling further children and bounds a hanging sleep', async () => {
    const controller = new AbortController();
    const exec = vi.fn<FleetAppExec>(async () => { controller.abort(); return reply(true); });
    expect(await cmdFleetAppsAwait(args, { ...deps(exec), signal: controller.signal })).toBe(1);
    expect(exec).toHaveBeenCalledTimes(1);
    output = '';
    vi.useFakeTimers();
    const result = cmdFleetAppsAwait(args, { ...deps(async () => reply(false)), sleep: () => new Promise(() => {}) });
    await vi.advanceTimersByTimeAsync(301);
    expect(await result).toBe(3);
  });

  it.each([
    [], ['--timeout-ms', '100'], ['--apps', ''], ['--apps', 'Codex,'],
    ['--apps', 'Codex,Codex'], ['--apps', 'codex'], ['--apps', 'Unknown'],
    [...args, '--apps', 'Safari'], [...args, '--json'], [...args, '--wat'],
    ['--apps', 'Codex', '--timeout-ms', '0'], ['--apps', 'Codex', '--timeout-ms', '300001'],
    [...args, '--interval-ms', '99'], [...args, '--interval-ms', '60001'],
  ])('rejects invalid selection or flags without discovery or execution: %j', async (...invalidArgs) => {
    const exec = vi.fn<FleetAppExec>(); const locateScript = vi.fn(() => null);
    expect(await cmdFleetAppsAwait(invalidArgs as string[], { exec, locateScript })).toBe(2);
    expect(exec).not.toHaveBeenCalled(); expect(locateScript).not.toHaveBeenCalled();
  });

  it('uses installed bridge fallback beneath the explicit temporary root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'apps-await-')); dirs.push(root);
    const bridge = join(root, 'mac-bridge', 'current'); mkdirSync(bridge, { recursive: true });
    writeFileSync(join(bridge, 'app_control.py'), '# fake fixture, never executed\n');
    const exec = vi.fn<FleetAppExec>(async () => reply(true));
    expect(await cmdFleetAppsAwait([...args, '--root', root], { exec, locateScript: () => null })).toBe(0);
    expect(exec.mock.calls[0]![1]).toEqual(['-I', realpathSync(join(bridge, 'app_control.py')), 'status', 'Codex', '--output-dir', root]);
    expect(output).not.toContain(root);
  });

  it('reports missing bridge and wholly unreadable probes as unavailable', async () => {
    expect(await cmdFleetAppsAwait(args, { locateScript: () => null, locateInstalledScript: () => null })).toBe(1);
    output = ''; let time = 0;
    expect(await cmdFleetAppsAwait(args, { ...deps(async () => ({ stdout: 'garbage /fake/host', stderr: '' })), now: () => time, sleep: async ms => { time += ms; } })).toBe(1);
    expect(view().apps.every(row => row.running === null)).toBe(true);
  });
});
