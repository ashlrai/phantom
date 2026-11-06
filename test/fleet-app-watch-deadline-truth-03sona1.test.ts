import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetAppWatch } from '../src/cli/fleet-app-watch.js';
import type { AppsEnsureChildRunner } from '../src/cli/fleet-apps-ensure.js';

let output = '';
const events = () => output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const success = { code: 0, stdout: JSON.stringify({ app: 'Cursor', outcome: 'launched', running: true }) };
const args = ['Cursor', '--duration-ms', '200', '--interval-ms', '100', '--jsonl'];
beforeEach(() => {
  output = '';
  vi.useFakeTimers();
  vi.spyOn(process.stdout, 'write').mockImplementation(((text: string) => { output += text; return true; }) as never);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it.each([false, true])('fails a hung observation after prior success: %s', async prior => {
  let reject!: (error: Error) => void;
  let childSignal: AbortSignal | undefined;
  const runner = vi.fn<AppsEnsureChildRunner>((_, options) => {
    if (prior && runner.mock.calls.length === 1) return Promise.resolve(success);
    childSignal = options.signal;
    return new Promise((_, fail) => { reject = fail; });
  });
  const pending = cmdFleetAppWatch(args, { runChild: runner, now: () => 0 });
  await vi.advanceTimersByTimeAsync(200);
  expect(await pending).toBe(1);
  expect(childSignal?.aborted).toBe(true);
  const before = output;
  reject(new Error('late fake failure'));
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(1000);
  expect(output).toBe(before);
  expect(runner).toHaveBeenCalledTimes(prior ? 2 : 1);
  expect(events().map(event => event.type)).toEqual(prior ? ['observation', 'observation', 'summary'] : ['observation', 'summary']);
  expect(events().at(-2)).toMatchObject({ outcome: 'failed', running: null, recovered: false });
  expect(events().at(-1)).toMatchObject({ outcome: 'failed', checks: prior ? 2 : 1, recoveries: prior ? 1 : 0, lastObservedState: prior ? 'running' : null });
});

it('completes when sleep consumes the duration', async () => {
  const runner = vi.fn<AppsEnsureChildRunner>().mockResolvedValue(success);
  const pending = cmdFleetAppWatch(args, { runChild: runner, now: () => 0 });
  await vi.advanceTimersByTimeAsync(200);
  expect(await pending).toBe(0);
  expect(runner).toHaveBeenCalledTimes(2);
  expect(events().map(event => event.type)).toEqual(['observation', 'observation', 'summary']);
  expect(events().at(-1)).toMatchObject({ outcome: 'completed', recoveries: 2 });
});

it('uses monotonic time when the injected clock moves backwards and sleep resolves immediately', async () => {
  let clock = 0;
  const runner = vi.fn<AppsEnsureChildRunner>().mockResolvedValue(success);
  const sleep = vi.fn(async () => { clock--; await vi.advanceTimersByTimeAsync(50); });
  expect(await cmdFleetAppWatch(args, { runChild: runner, now: () => clock, sleep })).toBe(0);
  expect(runner).toHaveBeenCalledTimes(4);
  expect(events().at(-1)).toMatchObject({ outcome: 'completed', elapsedMs: 200 });
});

it('keeps external cancellation distinct from observation expiry', async () => {
  const controller = new AbortController();
  let childSignal: AbortSignal | undefined;
  const runner = vi.fn<AppsEnsureChildRunner>((_, options) => { childSignal = options.signal; return new Promise(() => {}); });
  const pending = cmdFleetAppWatch(args, { runChild: runner, signal: controller.signal, now: () => 0 });
  await Promise.resolve();
  controller.abort();
  expect(await pending).toBe(1);
  expect(childSignal?.aborted).toBe(true);
  expect(events()).toEqual([expect.objectContaining({ type: 'summary', outcome: 'cancelled' })]);
  expect(runner).toHaveBeenCalledTimes(1);
});
