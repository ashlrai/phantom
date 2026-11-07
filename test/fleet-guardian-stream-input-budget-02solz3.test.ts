import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetGuardianStreamContinue } from '../src/cli/fleet-guardian-stream-continue.js';

beforeEach(() => { vi.useFakeTimers(); vi.spyOn(process.stderr, 'write').mockImplementation(() => true); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it.each(['', '{"record":', '{"record":"summary"}\n'])('times out stalled input without delegating: %s', async chunk => {
  const input = new PassThrough();
  const delegate = vi.fn(async () => 0);
  const pending = cmdFleetGuardianStreamContinue(['--stdin', '--input-timeout-ms', '100'], { input, delegate });
  if (chunk) input.write(chunk);
  await vi.advanceTimersByTimeAsync(100);
  expect(await pending).toBe(2);
  expect(delegate).not.toHaveBeenCalled();
  expect(process.stderr.write).toHaveBeenCalledWith('error: invalid guardian-stream-continue stream\n');
  expect(input.listenerCount('readable')).toBe(0);
  expect(input.listenerCount('end')).toBe(0);
  expect(input.listenerCount('error')).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it('does not reset the deadline for progress or await a stuck iterator return', async () => {
  const close = vi.fn(() => new Promise<IteratorResult<string>>(() => {}));
  let calls = 0;
  const input: AsyncIterable<string> = { [Symbol.asyncIterator]: () => ({
    next: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 20)); return { value: ' ', done: false }; },
    return: close,
  }) };
  const delegate = vi.fn(async () => 0);
  const pending = cmdFleetGuardianStreamContinue(['--stdin', '--input-timeout-ms', '100'], { input, delegate });
  await vi.advanceTimersByTimeAsync(100);
  expect(await pending).toBe(2);
  expect(calls).toBeGreaterThan(1);
  expect(close).toHaveBeenCalledOnce();
  expect(delegate).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(20);
  expect(vi.getTimerCount()).toBe(0);
});

it('forwards ordered flags and summary and cleans up on success', async () => {
  const input = new PassThrough();
  const summary = '{"record":"summary","value":42}';
  const delegate = vi.fn(async (_args: string[], deps?: { readInput?: () => Promise<string | Uint8Array> }) => {
    expect(await deps!.readInput!()).toBe(summary); return 7;
  });
  const args = ['--stdin', '--max-passes', '3', '--input-timeout-ms', '100', '--duration-ms', '20', '--interval-ms', '5'];
  const pending = cmdFleetGuardianStreamContinue(args, { input, delegate });
  input.end(`${summary}\n`);
  expect(await pending).toBe(7);
  expect(delegate).toHaveBeenCalledOnce();
  expect(delegate.mock.calls[0]![0]).toEqual(['--stdin', '--max-passes', '3', '--duration-ms', '20', '--interval-ms', '5']);
  expect(input.listenerCount('readable')).toBe(0);
  expect(input.listenerCount('end')).toBe(0);
  expect(input.listenerCount('error')).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['0', '300001', '-1', '1.5', '1e2', 'abc', ''])('validates timeout %s before input', async value => {
  const read = vi.fn();
  const input = { [Symbol.asyncIterator]: () => { read(); throw new Error(); } };
  const delegate = vi.fn(async () => 0);
  expect(await cmdFleetGuardianStreamContinue(['--stdin', '--input-timeout-ms', value], { input, delegate })).toBe(2);
  expect(read).not.toHaveBeenCalled(); expect(delegate).not.toHaveBeenCalled();
});

it('rejects duplicate timeout before input', async () => {
  const read = vi.fn();
  const input = { [Symbol.asyncIterator]: () => { read(); throw new Error(); } };
  expect(await cmdFleetGuardianStreamContinue(['--stdin', '--input-timeout-ms', '1', '--input-timeout-ms', '2'], { input })).toBe(2);
  expect(read).not.toHaveBeenCalled();
});
