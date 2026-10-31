import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdCommsBus } from '../src/cli/comms-bus.js';
import { BUS_PRIORITIES, type BusPriority } from '../src/core/fleet/bus-envelope.js';
import { appendBusInbox, listBusInboxAfter, type BusInboxPage } from '../src/core/fleet/bus-inbox.js';

const roots: string[] = [];
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'bus-priority-')); roots.push(root);
  return { root, now: () => 100 };
};
const message = (id: string, priority: BusPriority, from = 'alice', to = 'worker') =>
  ({ id, priority, from, to, ttl: 1000, body: `fake-${id}` });
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

it('reads each priority exactly, combines filters, and preserves unfiltered pages', async () => {
  const options = setup(), log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const rows = [message('0', 'P0'), message('1', 'P1'), message('2', 'P2'), message('3', 'P3'),
    message('other-from', 'P0', 'bob'), message('other-to', 'P0', 'alice', 'elsewhere')];
  for (const row of rows) expect(appendBusInbox(row, options).status).toBe('posted');
  const read = async (...args: string[]) => {
    expect(await cmdCommsBus(['read', ...args], options)).toBe(0);
    return JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  };
  const original = await read();
  expect(original).toEqual(listBusInboxAfter(0, 50, options));
  for (const priority of BUS_PRIORITIES) {
    const page = await read('--priority', priority);
    expect(page.nextCursor).toBe(original.nextCursor);
    expect(page.messages).toEqual(original.messages.filter((row: { envelope: { priority: string } }) => row.envelope.priority === priority));
  }
  const combined = await read('--priority', 'P0', '--to', 'worker', '--from', 'alice');
  expect(combined.messages).toEqual([original.messages[0]]);
  expect(combined.nextCursor).toBe(6);
  expect(await read()).toEqual(original);
});

it('filters only the scanned page and resumes without changing cursor, order, or receipt time', async () => {
  const options = setup(), log = vi.spyOn(console, 'log').mockImplementation(() => {});
  for (const row of [message('first', 'P2'), message('second', 'P0'), message('third', 'P0')]) {
    expect(appendBusInbox(row, options).status).toBe('posted');
  }
  const later = { ...options, now: () => 150 };
  const read = async (after: number, limit: number) => {
    expect(await cmdCommsBus(['read', '--after', String(after), '--limit', String(limit), '--priority', 'P0'], later)).toBe(0);
    return JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  };
  const first = await read(0, 1);
  expect(first).toEqual({ status: 'ok', messages: [], nextCursor: 1 });
  const second = await read(first.nextCursor, 2);
  expect(second).toEqual(listBusInboxAfter(1, 2, later));
  expect(second.messages.map((row: { receivedAt: number }) => row.receivedAt)).toEqual([100, 100]);
  expect(second.messages.map((row: { envelope: { ttl: number } }) => row.envelope.ttl)).toEqual([950, 950]);
});

it('watch emits an unmatched page and polls from its cursor', async () => {
  vi.useFakeTimers();
  const options = setup(), abort = new AbortController(), pages: BusInboxPage[] = [];
  for (const row of [message('first', 'P3'), message('second', 'P0')]) {
    expect(appendBusInbox(row, options).status).toBe('posted');
  }
  const list = vi.fn(listBusInboxAfter);
  const run = cmdCommsBus(['watch', '--priority', 'P0', '--to', 'worker', '--from', 'alice', '--limit', '1', '--interval-ms', '100'], options,
    { signal: abort.signal, list, emit: json => pages.push(JSON.parse(json)) });
  expect(pages).toEqual([{ status: 'ok', messages: [], nextCursor: 1 }]);
  await vi.advanceTimersByTimeAsync(100);
  expect(list.mock.calls.map(call => [call[0], call[1]])).toEqual([[0, 1], [1, 1]]);
  expect(pages[1]).toEqual(listBusInboxAfter(1, 1, options));
  abort.abort();
  expect(await run).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it('rejects malformed priority options and post misuse without polling', async () => {
  const options = setup(), log = vi.spyOn(console, 'log').mockImplementation(() => {}), list = vi.fn(listBusInboxAfter);
  for (const verb of ['read', 'watch']) {
    for (const args of [['--priority'], ['--priority', ''], ['--priority', 'p0'], ['--priority', 'P4'],
      ['--priority', 'P0 ', '--to', 'worker'], ['--priority', '--limit', '1'], ['--priority', 'P0', '--priority', 'P1']]) {
      expect(await cmdCommsBus([verb, ...args], options, { list })).toBe(2);
      expect(log.mock.calls.at(-1)?.[0]).toBe('{"status":"invalid"}');
    }
  }
  expect(await cmdCommsBus(['post', '--file', 'unused', '--priority', 'P0'], options)).toBe(2);
  expect(log.mock.calls.at(-1)?.[0]).toBe('{"status":"invalid"}');
  expect(list).not.toHaveBeenCalled();
});

it('documents the filter, scan limit, and routing-only meaning of priority', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['--help'])).toBe(0);
  const help = String(log.mock.calls[0]?.[0]);
  expect(help).toContain('--priority <P0|P1|P2|P3>');
  expect(help).toContain('counts scanned live records');
  expect(help).toContain('Expired records advance the cursor but do not count toward the limit');
  expect(help).toContain('Priority is a routing attribute, not authority');
});
