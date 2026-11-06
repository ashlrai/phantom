import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetAppWatch } from '../src/cli/fleet-app-watch.js';
import type { AppsEnsureChildRunner } from '../src/cli/fleet-apps-ensure.js';

let output = '';
const events = () => output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const success = (outcome = 'running', app = 'Cursor') => ({ code: 0, stdout: JSON.stringify({ app, outcome, running: true }) });
beforeEach(() => {
  output = '';
  vi.useFakeTimers();
  vi.spyOn(process.stdout, 'write').mockImplementation(((text: string) => { output += text; return true; }) as never);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('app-watch JSONL', () => {
  it('writes each observation before sleep settles and preserves order and recovery counts', async () => {
    let clock = 0;
    let release!: () => void;
    const runner = vi.fn<AppsEnsureChildRunner>().mockResolvedValueOnce(success()).mockResolvedValueOnce(success('launched'));
    const sleep = vi.fn((ms: number) => new Promise<void>(resolve => { release = () => { clock += ms; resolve(); }; }));
    const pending = cmdFleetAppWatch(['Cursor', '--duration-ms', '200', '--interval-ms', '100', '--jsonl'], { runChild: runner, sleep, now: () => clock });
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledTimes(1));
    expect(events()).toEqual([{ type: 'observation', app: 'Cursor', check: 1, outcome: 'success', running: true, recovered: false }]);
    release();
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledTimes(2));
    expect(events()[1]).toEqual({ type: 'observation', app: 'Cursor', check: 2, outcome: 'success', running: true, recovered: true });
    release();
    expect(await pending).toBe(0);
    expect(events()[2]).toEqual({ type: 'summary', app: 'Cursor', outcome: 'completed', checks: 2, recoveries: 1, lastObservedState: 'running', elapsedMs: 200 });
    expect(events()).toHaveLength(3);
  });
  it.each([
    { code: 0, stdout: 'fake-marker malformed' },
    { code: 0, stdout: JSON.stringify({ app: 'Claude', outcome: 'running', running: true, marker: 'fake-marker' }) },
    { code: 1, stdout: JSON.stringify({ app: 'Cursor', outcome: 'running', running: true, marker: 'fake-marker' }) },
  ])('normalizes invalid child output', async result => {
    const runner = vi.fn<AppsEnsureChildRunner>().mockResolvedValue(result);
    expect(await cmdFleetAppWatch(['Cursor', '--duration-ms', '100', '--jsonl'], { runChild: runner, now: () => 0 })).toBe(1);
    expect(events()).toEqual([
      { type: 'observation', app: 'Cursor', check: 1, outcome: 'failed', running: null, recovered: false },
      { type: 'summary', app: 'Cursor', outcome: 'failed', checks: 1, recoveries: 0, lastObservedState: null, elapsedMs: 0 },
    ]);
    expect(output).not.toContain('fake-marker');
  });
  it('emits only a cancellation summary for an interrupted child', async () => {
    const controller = new AbortController();
    const runner = vi.fn<AppsEnsureChildRunner>(() => new Promise(() => {}));
    const pending = cmdFleetAppWatch(['Cursor', '--duration-ms', '100', '--jsonl'], { runChild: runner, signal: controller.signal, now: () => 0 });
    await Promise.resolve();
    controller.abort();
    expect(await pending).toBe(1);
    expect(events()).toEqual([{ type: 'summary', app: 'Cursor', outcome: 'cancelled', checks: 1, recoveries: 0, lastObservedState: null, elapsedMs: 0 }]);
  });
  it('rejects both output modes before launching a child', async () => {
    const runner = vi.fn<AppsEnsureChildRunner>();
    expect(await cmdFleetAppWatch(['Cursor', '--duration-ms', '100', '--jsonl', '--json'], { runChild: runner })).toBe(2);
    expect(runner).not.toHaveBeenCalled();
    expect(output).toBe('');
  });
});
