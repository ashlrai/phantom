import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdCommsBus } from '../src/cli/comms-bus.js';
import { appendBusInbox, listBusInboxAfter, type BusInboxPage, type BusInboxReceipt } from '../src/core/fleet/bus-inbox.js';

const roots: string[] = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'bus-correlation-recut-'));
  roots.push(root);
  return { root, now: () => 100 };
}
function message(id: string, body: unknown, from = 'worker', to = 'coordinator', priority = 'P1', ttl = 1000) {
  return { id, from, to, priority, ttl, body };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('matches only exact own string correlations and intersects all other filters', async () => {
  const options = setup(), log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const rows = [
    message('request-1', { question: 'fake' }), message('null', null), message('array', [{ inReplyTo: 'request-1' }]),
    message('number', { inReplyTo: 1 }), message('nested', { nested: { inReplyTo: 'request-1' } }),
    message('case', { inReplyTo: 'Request-1' }), message('reply', { inReplyTo: 'request-1' }),
    message('other-sender', { inReplyTo: 'request-1' }, 'other'),
    message('other-recipient', { inReplyTo: 'request-1' }, 'worker', 'other'),
    message('other-priority', { inReplyTo: 'request-1' }, 'worker', 'coordinator', 'P2'),
    message('flag-value', { inReplyTo: '--id' }),
  ];
  for (const row of rows) expect(appendBusInbox(row, options).status).toBe('posted');
  for (const [args, ids] of [
    [['--in-reply-to', 'request-1'], ['reply', 'other-sender', 'other-recipient', 'other-priority']],
    [['--in-reply-to=request-1', '--id', 'reply', '--from', 'worker', '--to', 'coordinator', '--exclude-from', 'other', '--priority', 'P1'], ['reply']],
    [['--in-reply-to', 'request-1', '--exclude-from', 'worker'], ['other-sender']],
    [['--in-reply-to', 'Request-1'], ['case']],
    [['--in-reply-to=--id'], ['flag-value']],
  ] as const) {
    expect(await cmdCommsBus(['read', ...args], options)).toBe(0);
    const page = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(page.nextCursor).toBe(rows.length);
    expect(page.messages.map((row: BusInboxReceipt) => row.envelope.id)).toEqual(ids);
  }
}, 30000);

it('advances over expired and filtered live records even when the page is empty', async () => {
  const options = setup(), log = vi.spyOn(console, 'log').mockImplementation(() => {});
  for (const row of [message('expired', { inReplyTo: 'request-1' }, 'worker', 'coordinator', 'P1', 50),
    message('unrelated', null), message('wrong-case', { inReplyTo: 'Request-1' }), message('reply', { inReplyTo: 'request-1' })]) {
    expect(appendBusInbox(row, options).status).toBe('posted');
  }
  const read = async (after: number) => {
    expect(await cmdCommsBus(['read', '--in-reply-to', 'request-1', '--limit', '1', '--after', String(after)], { ...options, now: () => 150 })).toBe(0);
    return JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  };
  expect(await read(0)).toEqual({ status: 'ok', messages: [], nextCursor: 2 });
  expect(await read(2)).toEqual({ status: 'ok', messages: [], nextCursor: 3 });
  expect(await read(3)).toMatchObject({ status: 'ok', messages: [{ cursor: 4, envelope: { id: 'reply' } }], nextCursor: 4 });
  expect(await read(4)).toEqual({ status: 'ok', messages: [], nextCursor: 4 });
});

it('watches bounded filtered pages and cancels without leaving timers or signal listeners', async () => {
  vi.useFakeTimers();
  const options = setup(), pages: BusInboxPage[] = [], abort = new AbortController();
  for (const row of [message('unrelated', null), message('reply', { inReplyTo: 'request-1' }), message('later', { inReplyTo: 'request-1' })]) {
    expect(appendBusInbox(row, options).status).toBe('posted');
  }
  const list = vi.fn(listBusInboxAfter);
  const beforeInt = process.listenerCount('SIGINT'), beforeTerm = process.listenerCount('SIGTERM');
  const run = cmdCommsBus(['watch', '--in-reply-to=request-1', '--limit', '1', '--interval-ms', '100', '--max-pages', '3'], options,
    { signal: abort.signal, list, emit: json => pages.push(JSON.parse(json) as BusInboxPage) });
  expect(pages).toEqual([{ status: 'ok', messages: [], nextCursor: 1 }]);
  await vi.advanceTimersByTimeAsync(100);
  expect(pages[1]).toMatchObject({ status: 'ok', messages: [{ cursor: 2, envelope: { id: 'reply' } }], nextCursor: 2 });
  abort.abort();
  expect(await run).toBe(0);
  expect(list.mock.calls.map(call => call[0])).toEqual([0, 1]);
  expect(vi.getTimerCount()).toBe(0);
  expect(process.listenerCount('SIGINT')).toBe(beforeInt);
  expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
});

it('rejects inherited properties and arrays even when supplied by a list implementation', async () => {
  const inherited = Object.create({ inReplyTo: 'request-1' });
  const array = Object.assign([], { inReplyTo: 'request-1' });
  const page = { status: 'ok', nextCursor: 2, messages: [
    { cursor: 1, receivedAt: 100, envelope: message('inherited', inherited) },
    { cursor: 2, receivedAt: 100, envelope: message('array', array) },
  ] } as BusInboxPage;
  const emit = vi.fn();
  expect(await cmdCommsBus(['watch', '--in-reply-to', 'request-1', '--max-pages', '1'], {}, { list: () => page, emit })).toBe(0);
  expect(JSON.parse(emit.mock.calls[0]![0])).toEqual({ status: 'ok', messages: [], nextCursor: 2 });
});

it('rejects malformed and duplicate options and documents the convention', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {}), list = vi.fn(listBusInboxAfter);
  for (const verb of ['read', 'watch']) {
    for (const args of [['--in-reply-to'], ['--in-reply-to='], ['--in-reply-to', '--limit', '1'],
      ['--in-reply-to', '--to=worker'], ['--in-reply-to', 'one', '--in-reply-to=two'],
      ['--in-reply-to', 'two words'], ['--in-reply-to', 'x'.repeat(129)]]) {
      expect(await cmdCommsBus([verb, ...args], {}, { list })).toBe(2);
      expect(log.mock.calls.at(-1)?.[0]).toBe('{"status":"invalid"}');
    }
  }
  expect(await cmdCommsBus(['post', '--file', 'fake', '--in-reply-to', 'request-1'])).toBe(2);
  expect(list).not.toHaveBeenCalled();
  expect(await cmdCommsBus(['--help'])).toBe(0);
  const help = String(log.mock.calls.at(-1)?.[0]);
  expect(help).toContain('application convention, not an envelope field or authenticated identity');
  expect(help).toContain('{"inReplyTo":"request-1"}');
  expect(help).toContain('phm comms bus read --in-reply-to request-1');
});
