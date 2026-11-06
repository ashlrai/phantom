import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetAppsAwait, type FleetAppsAwaitDeps } from '../src/cli/fleet-apps-await.js';

const args = ['--apps', 'Codex,Claude,Cursor,Safari', '--timeout-ms', '100', '--json'];
const reply = { stdout: JSON.stringify({ ok: true, running: true }), stderr: '' };
let output = '';
beforeEach(() => {
  output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const setup = (exec: NonNullable<FleetAppsAwaitDeps['exec']>, signal?: AbortSignal): FleetAppsAwaitDeps =>
  ({ exec, signal, locateScript: () => '/fake/app_control.py' });

describe('fleet apps-await probe lifecycle', () => {
  it('forwards cancellation to hung probes and ignores their late settlement', async () => {
    const supervisor = new AbortController();
    const pending: Array<{ resolve: (value: typeof reply) => void; reject: (reason: Error) => void }> = [];
    const signals: AbortSignal[] = [];
    const exec = vi.fn<NonNullable<FleetAppsAwaitDeps['exec']>>((_file, _argv, options) => {
      signals.push(options.signal);
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    });
    const result = cmdFleetAppsAwait(args, setup(exec, supervisor.signal));
    expect(exec).toHaveBeenCalledTimes(2);
    supervisor.abort();
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(await result).toBe(1);
    const emitted = output;
    pending[0]!.resolve(reply);
    pending[1]!.reject(new Error('late failure'));
    await Promise.resolve();
    await Promise.resolve();
    expect(output).toBe(emitted);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(JSON.parse(output).apps.every((row: { running: boolean | null }) => row.running === null)).toBe(true);
  });

  it('cancels active probes on expiration without starting the remaining apps', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const exec = vi.fn<NonNullable<FleetAppsAwaitDeps['exec']>>((_file, _argv, options) => {
      signals.push(options.signal);
      return new Promise(() => {});
    });
    const result = cmdFleetAppsAwait(args, setup(exec));
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toBe(1);
    expect(signals).toHaveLength(2);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('cleans up the probe signal and supervisor listener on success', async () => {
    const supervisor = new AbortController();
    const remove = vi.spyOn(supervisor.signal, 'removeEventListener');
    const signals: AbortSignal[] = [];
    const exec: NonNullable<FleetAppsAwaitDeps['exec']> = async (_file, _argv, options) => {
      signals.push(options.signal);
      return reply;
    };
    expect(await cmdFleetAppsAwait(args, setup(exec, supervisor.signal))).toBe(0);
    expect(signals).toHaveLength(4);
    expect(signals.every(signal => signal === signals[0] && signal.aborted)).toBe(true);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(JSON.parse(output).outcome).toBe('ready');
  });

  it('does not launch a child when already cancelled', async () => {
    const supervisor = new AbortController();
    supervisor.abort();
    const exec = vi.fn<NonNullable<FleetAppsAwaitDeps['exec']>>();
    expect(await cmdFleetAppsAwait(args, setup(exec, supervisor.signal))).toBe(1);
    expect(exec).not.toHaveBeenCalled();
  });
});
