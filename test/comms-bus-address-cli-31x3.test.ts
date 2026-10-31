import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdCommsBus } from '../src/cli/comms-bus.js';
import { appendBusInbox, listBusInboxAfter, type BusInboxPage } from '../src/core/fleet/bus-inbox.js';
import { validateBusEnvelope } from '../src/core/fleet/bus-envelope.js';

const roots: string[] = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'bus-address-')); roots.push(root);
  return { root, now: () => 100 };
}
function message(id: string, from: string, to: string, ttl = 1000) {
  return { id, from, to, priority: 'P1', ttl, body: `payload-${id}` };
}
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

it('filters exact recipient and sender labels independently and together', async () => {
  const options = setup(), log = vi.spyOn(console, 'log').mockImplementation(() => {});
  for (const row of [message('1', 'alice', 'worker'), message('2', 'bob', 'worker'),
    message('3', 'alice', 'Worker'), message('4', 'Alice', 'worker')]) {
    expect(appendBusInbox(row, options).status).toBe('posted');
  }
  for (const [args, ids] of [
    [['--to', 'worker'], ['1', '2', '4']],
    [['--from', 'alice'], ['1', '3']],
    [['--to', 'worker', '--from', 'alice'], ['1']],
    [[], ['1', '2', '3', '4']],
  ] as const) {
    expect(await cmdCommsBus(['read', ...args], options)).toBe(0);
    const page = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(page.nextCursor).toBe(4);
    expect(page.messages.map((row: { envelope: { id: string } }) => row.envelope.id)).toEqual(ids);
  }
});

it('advances an unmatched page and resumes at the global cursor, including expired rows', async () => {
  const options = setup(), log = vi.spyOn(console, 'log').mockImplementation(() => {});
  for (const row of [message('expired', 'a', 'worker', 50), message('other', 'a', 'elsewhere'),
    message('match', 'a', 'worker'), message('last', 'a', 'elsewhere')]) {
    expect(appendBusInbox(row, options).status).toBe('posted');
  }
  const read = async (after: number) => {
    expect(await cmdCommsBus(['read', '--to', 'worker', '--limit', '1', '--after', String(after)],
      { ...options, now: () => 150 })).toBe(0);
    return JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  };
  const first = await read(0);
  expect(first).toEqual({ status: 'ok', messages: [], nextCursor: 2 });
  const second = await read(first.nextCursor);
  expect(second).toMatchObject({ status: 'ok', messages: [{ cursor: 3, envelope: { id: 'match' } }], nextCursor: 3 });
  expect(await read(second.nextCursor)).toEqual({ status: 'ok', messages: [], nextCursor: 4 });
  expect(await read(4)).toEqual({ status: 'ok', messages: [], nextCursor: 4 });
});

it('watch emits filtered empty pages, retries contention at the same cursor, and cancels cleanly', async () => {
  vi.useFakeTimers();
  const options = setup(), abort = new AbortController(), pages: BusInboxPage[] = [];
  expect(appendBusInbox(message('other', 'alice', 'other'), options).status).toBe('posted');
  expect(appendBusInbox(message('wrong-sender', 'bob', 'worker'), options).status).toBe('posted');
  expect(appendBusInbox(message('match', 'alice', 'worker'), options).status).toBe('posted');
  const list = vi.fn<typeof listBusInboxAfter>()
    .mockImplementationOnce(listBusInboxAfter)
    .mockReturnValueOnce({ status: 'retryable' })
    .mockImplementation(listBusInboxAfter);
  const beforeInt = process.listenerCount('SIGINT'), beforeTerm = process.listenerCount('SIGTERM');
  const run = cmdCommsBus(['watch', '--to', 'worker', '--from', 'alice', '--limit', '2', '--interval-ms', '100'], options,
    { signal: abort.signal, list, emit: json => pages.push(JSON.parse(json)) });
  expect(pages).toEqual([{ status: 'ok', messages: [], nextCursor: 2 }]);
  await vi.advanceTimersByTimeAsync(100);
  expect(pages).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(100);
  expect(list.mock.calls.map(call => call[0])).toEqual([0, 2, 2]);
  expect(pages[1]).toMatchObject({ status: 'ok', messages: [{ cursor: 3, envelope: { id: 'match' } }], nextCursor: 3 });
  abort.abort();
  expect(await run).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  expect(process.listenerCount('SIGINT')).toBe(beforeInt);
  expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
});

it('validates filters against the envelope contract and rejects malformed options and post filters', async () => {
  const options = setup(), log = vi.spyOn(console, 'log').mockImplementation(() => {}), list = vi.fn(listBusInboxAfter);
  const labels = ['a', 'a'.repeat(128), '-worker', 'agent:worker/1@pool_*', 'x'.repeat(129), 'two words', 'x\n', 'é', ''];
  for (const label of labels) {
    const valid = validateBusEnvelope({ id: label, from: label, to: label, priority: 'P3', ttl: 1, body: null }).ok;
    for (const flag of ['--to', '--from']) {
      expect(await cmdCommsBus(['read', flag, label], options)).toBe(valid ? 0 : 2);
    }
  }
  for (const flag of ['--to', '--from']) {
    expect(await cmdCommsBus(['read', `${flag}=${flag}`], options)).toBe(0);
  }
  for (const verb of ['read', 'watch']) {
    for (const args of [['--to'], ['--from'], ['--to', '--from', 'a'], ['--from', '--to', 'a'],
      ['--to', '--from=a'], ['--to', 'a', '--to=b'], ['--from', 'a', '--from', 'b'],
      ['--to='], ['--to', 'a b'], ['--from', 'a'.repeat(129)]]) {
      expect(await cmdCommsBus([verb, ...args], options, { list })).toBe(2);
      expect(log.mock.calls.at(-1)?.[0]).toBe('{"status":"invalid"}');
    }
  }
  expect(list).not.toHaveBeenCalled();
  for (const flag of ['--to', '--from']) {
    expect(await cmdCommsBus(['post', '--file', 'unused', flag, 'worker'], options)).toBe(2);
    expect(log.mock.calls.at(-1)?.[0]).toBe('{"status":"invalid"}');
  }
});

it('documents filter semantics and the absence of authenticated identity', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['--help'])).toBe(0);
  const help = String(log.mock.calls[0]?.[0]);
  expect(help).toContain('routing labels do not confer authenticated identity');
  expect(help).toContain('Limit applies before filtering');
});
