import { EventEmitter, getEventListeners } from 'node:events';
import { expect, it, vi } from 'vitest';
import { cmdFleetEmailOutboxBatchAwait } from '../src/cli/fleet-email-outbox-batch-await.js';

const args = ['--stdin', '--timeout-ms', '300', '--json'];
const deadline = async <T>(promise: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('deadline')), 1000); })]); }
  finally { clearTimeout(timer); }
};

it.each(['already aborted', 'abort', 'SIGINT', 'SIGTERM'])('cancels blocked input: %s', async (mode) => {
  const controller = new AbortController(); const signals = new EventEmitter(); const lines: string[] = [];
  const next = vi.fn(() => new Promise<IteratorResult<string>>(() => {}));
  const close = vi.fn(() => new Promise<IteratorResult<string>>(() => {}));
  const stdin = { [Symbol.asyncIterator]: () => ({ next, return: close }) };
  const read = vi.fn();
  if (mode === 'already aborted') controller.abort();
  const pending = cmdFleetEmailOutboxBatchAwait(args, { stdin, signal: controller.signal, signals: signals as unknown as NodeJS.Process, stdout: (line) => lines.push(line), read });
  if (mode === 'abort') controller.abort();
  if (mode === 'SIGINT' || mode === 'SIGTERM') signals.emit(mode);
  expect(await deadline(pending)).toBe(130);
  expect(JSON.parse(lines[0]!)).toEqual({ rows: [], timedOut: false, cancelled: true, sourceFailure: false });
  expect(read).not.toHaveBeenCalled();
  expect(next).toHaveBeenCalledTimes(mode === 'already aborted' ? 0 : 1);
  expect(signals.listenerCount('SIGINT') + signals.listenerCount('SIGTERM')).toBe(0);
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
});

it.each(['split', 'invalid', 'failure'])('cleans listeners after %s input', async (mode) => {
  const controller = new AbortController(); const signals = new EventEmitter();
  const stdin = (async function* () {
    if (mode === 'failure') throw new Error('input failed');
    yield mode === 'split' ? '["a.' : '{}';
    if (mode === 'split') yield 'reply.eml"]';
  })();
  const code = await deadline(cmdFleetEmailOutboxBatchAwait(args, { stdin, signal: controller.signal, signals: signals as unknown as NodeJS.Process, runsDir: '/nonexistent/fake-batch-test', stdout: () => {}, stderr: () => {} }));
  expect(code).toBe(mode === 'split' ? 1 : 2);
  expect(signals.listenerCount('SIGINT') + signals.listenerCount('SIGTERM')).toBe(0);
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
});
