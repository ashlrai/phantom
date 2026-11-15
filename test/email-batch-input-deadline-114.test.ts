import { EventEmitter, getEventListeners } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetEmailOutboxBatchAwait } from '../src/cli/fleet-email-outbox-batch-await.js';
import { writeEmailDropConfig } from '../src/core/comms/email-drop-config.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const args = ['--stdin', '--timeout-ms', '300', '--poll-ms', '100', '--json'];
const deadline = async <T>(promise: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('deadline')), 2000); })]); }
  finally { clearTimeout(timer); }
};

type CmdDeps = NonNullable<Parameters<typeof cmdFleetEmailOutboxBatchAwait>[1]>;

function harness(extra: CmdDeps = {}) {
  const controller = new AbortController();
  const signals = new EventEmitter();
  const lines: string[] = [];
  const deps: CmdDeps = {
    signal: controller.signal,
    signals: signals as unknown as NodeJS.Process,
    stdout: (line: string) => lines.push(line),
    stderr: () => {},
    ...extra,
  };
  return { controller, signals, lines, deps };
}

it('times out a never-resolving input iterator within the configured bound', async () => {
  const next = vi.fn(() => new Promise<IteratorResult<string>>(() => {}));
  const close = vi.fn(() => new Promise<IteratorResult<string>>(() => {}));
  const stdin = { [Symbol.asyncIterator]: () => ({ next, return: close }) };
  const h = harness({ stdin });
  const started = Date.now();
  const code = await deadline(cmdFleetEmailOutboxBatchAwait(['--stdin', '--timeout-ms', '120', '--poll-ms', '100', '--json'], h.deps));
  expect(code).toBe(1);
  expect(Date.now() - started).toBeLessThan(1500);
  expect(h.lines).toHaveLength(1);
  expect(JSON.parse(h.lines[0]!)).toEqual({ rows: [], timedOut: true, cancelled: false, sourceFailure: false });
  expect(next).toHaveBeenCalledTimes(1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(close).toHaveBeenCalledTimes(1);
  expect(next).toHaveBeenCalledTimes(1);
  expect(h.signals.listenerCount('SIGINT') + h.signals.listenerCount('SIGTERM')).toBe(0);
  expect(getEventListeners(h.controller.signal, 'abort')).toHaveLength(0);
});

it('does not let slow chunks reset the absolute input deadline', async () => {
  let fakeNow = 0;
  const chunks = ['["a.', 'reply.eml"]'];
  let index = 0;
  const stdin = {
    [Symbol.asyncIterator]: () => ({
      next: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        fakeNow += 120;
        return index < chunks.length ? { done: false as const, value: chunks[index++]! } : { done: true as const, value: undefined };
      }),
    }),
  };
  const read = vi.fn(() => ({ dir: '', counts: { queued: 0, sent: 0, drafted: 0, stuck: 0 }, entries: [] }));
  const h = harness({ stdin, now: () => fakeNow, read });
  const code = await deadline(cmdFleetEmailOutboxBatchAwait(['--stdin', '--timeout-ms', '200', '--poll-ms', '100', '--json'], h.deps));
  expect(code).toBe(1);
  expect(h.lines).toHaveLength(1);
  expect(JSON.parse(h.lines[0]!)).toMatchObject({ timedOut: true, cancelled: false });
  expect(read).not.toHaveBeenCalled();
});

it('leaves only the remaining budget for the outbox wait after EOF', async () => {
  const root = mkdtempSync(join(tmpdir(), 'batch-input-deadline-')); roots.push(root);
  const outbox = join(root, 'outbox'); mkdirSync(outbox);
  await writeEmailDropConfig(root, { v: 1, inboxDir: join(root, 'inbox'), outboxDir: outbox, from: ['fake@example.test'] });
  let fakeNow = 0;
  const stdin = (async function* () { fakeNow += 200; yield JSON.stringify(['a.reply.eml']); })();
  const read = vi.fn(() => ({ dir: '', counts: { queued: 0, sent: 0, drafted: 0, stuck: 0 }, entries: [] }));
  const h = harness({ runsDir: root, stdin, now: () => fakeNow, read, sleep: async (ms: number) => { fakeNow += ms; } });
  const code = await deadline(cmdFleetEmailOutboxBatchAwait(args, h.deps));
  expect(code).toBe(1);
  expect(JSON.parse(h.lines[0]!)).toMatchObject({ timedOut: true, rows: [{ name: 'a.reply.eml', state: 'missing' }] });
  expect(read).toHaveBeenCalledTimes(2);
});

it('cancellation still wins over a pending input deadline', async () => {
  const h = harness({ stdin: { [Symbol.asyncIterator]: () => ({ next: vi.fn(() => new Promise<IteratorResult<string>>(() => {})) }) } });
  const pending = cmdFleetEmailOutboxBatchAwait(args, h.deps);
  h.controller.abort();
  expect(await deadline(pending)).toBe(130);
  expect(JSON.parse(h.lines[0]!)).toEqual({ rows: [], timedOut: false, cancelled: true, sourceFailure: false });
  expect(h.signals.listenerCount('SIGINT') + h.signals.listenerCount('SIGTERM')).toBe(0);
  expect(getEventListeners(h.controller.signal, 'abort')).toHaveLength(0);
});

it('keeps ordinary completed input semantics unchanged', async () => {
  const root = mkdtempSync(join(tmpdir(), 'batch-input-deadline-')); roots.push(root);
  const outbox = join(root, 'outbox'); mkdirSync(outbox);
  mkdirSync(join(outbox, 'sent'));
  writeFileSync(join(outbox, 'sent', 'a.reply.eml'), 'To: fake@example.test\nSubject: fake\n\nfake');
  await writeEmailDropConfig(root, { v: 1, inboxDir: join(root, 'inbox'), outboxDir: outbox, from: ['fake@example.test'] });
  const stdin = (async function* () { yield JSON.stringify(['a.reply.eml']); })();
  const h = harness({ runsDir: root, stdin });
  const code = await deadline(cmdFleetEmailOutboxBatchAwait(args, h.deps));
  expect(code).toBe(0);
  expect(JSON.parse(h.lines[0]!)).toMatchObject({ timedOut: false, cancelled: false, rows: [{ name: 'a.reply.eml', state: 'sent' }] });
});
