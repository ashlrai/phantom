import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdCommsBus } from '../src/cli/comms-bus.js';
import * as inbox from '../src/core/fleet/bus-inbox.js';

const roots: string[] = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'bus-id-filter-')); roots.push(root);
  return { root, now: () => 100 };
}
function message(id: string, from = 'alice', to = 'worker', priority = 'P0', ttl = 1000) {
  return { id, from, to, priority, ttl, body: { id: 'fake-body-id' } };
}
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

it('scans multiple empty pages and preserves the cursor across expired and live records', async () => {
  const options = setup(), log = vi.spyOn(console, 'log').mockImplementation(() => {});
  for (const row of [message('expired', 'alice', 'worker', 'P0', 50), message('other'), message('Target'), message('target'), message('last')]) {
    expect(inbox.appendBusInbox(row, options).status).toBe('posted');
  }
  const read = async (after: number) => {
    expect(await cmdCommsBus(['read', '--id', 'target', '--limit', '1', '--after', String(after)], { ...options, now: () => 150 })).toBe(0);
    return JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  };
  expect(await read(0)).toEqual({ status: 'ok', messages: [], nextCursor: 2 });
  expect(await read(2)).toEqual({ status: 'ok', messages: [], nextCursor: 3 });
  expect(await read(3)).toMatchObject({ status: 'ok', messages: [{ cursor: 4, envelope: { id: 'target' } }], nextCursor: 4 });
  expect(await read(4)).toEqual({ status: 'ok', messages: [], nextCursor: 5 });
  expect(await read(5)).toEqual({ status: 'ok', messages: [], nextCursor: 5 });
});

it('intersects the ID with every other filter and keeps default reads unchanged', async () => {
  const options = setup(), log = vi.spyOn(console, 'log').mockImplementation(() => {});
  for (const row of [message('target'), message('other'), message('--id')]) {
    expect(inbox.appendBusInbox(row, options).status).toBe('posted');
  }
  for (const [args, ids] of [
    [[], ['target', 'other', '--id']],
    [['--id', 'target', '--from', 'alice', '--to', 'worker', '--priority', 'P0'], ['target']],
    [['--id', 'target', '--from', 'Alice'], []],
    [['--id', 'target', '--to', 'Worker'], []],
    [['--id', 'target', '--priority', 'P1'], []],
    [['--id', 'fake-body-id'], []],
    [['--id=--id'], ['--id']],
  ] as const) {
    expect(await cmdCommsBus(['read', ...args], options)).toBe(0);
    const page = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(page.nextCursor).toBe(3);
    expect(page.messages.map((row: inbox.BusInboxReceipt) => row.envelope.id)).toEqual(ids);
  }
});

it('watch advances past unmatched pages and retries contention at the same cursor', async () => {
  vi.useFakeTimers();
  const options = setup(), pages: inbox.BusInboxPage[] = [];
  for (const row of [message('other'), message('Target'), message('target')]) {
    expect(inbox.appendBusInbox(row, options).status).toBe('posted');
  }
  const list = vi.fn<typeof inbox.listBusInboxAfter>()
    .mockImplementationOnce(inbox.listBusInboxAfter).mockReturnValueOnce({ status: 'retryable' })
    .mockImplementation(inbox.listBusInboxAfter);
  const run = cmdCommsBus(['watch', '--id', 'target', '--from', 'alice', '--to', 'worker', '--priority', 'P0', '--limit', '1', '--interval-ms', '100', '--max-pages', '3'], options,
    { list, emit: json => pages.push(JSON.parse(json)) });
  expect(pages).toEqual([{ status: 'ok', messages: [], nextCursor: 1 }]);
  await vi.advanceTimersByTimeAsync(300);
  expect(await run).toBe(0);
  expect(list.mock.calls.map(call => call[0])).toEqual([0, 1, 1, 2]);
  expect(pages[1]).toEqual({ status: 'ok', messages: [], nextCursor: 2 });
  expect(pages[2]).toMatchObject({ status: 'ok', messages: [{ cursor: 3, envelope: { id: 'target' } }], nextCursor: 3 });
});

it('rejects missing, duplicate and invalid IDs before accessing the inbox', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {}), list = vi.spyOn(inbox, 'listBusInboxAfter');
  for (const verb of ['read', 'watch']) {
    for (const args of [
      ['--id'], ['--id', ''], ['--id='], ['--id', '--limit', '1'], ['--id', '--to=worker'],
      ['--id', 'one', '--id', 'two'], ['--id=one', '--id', 'one'], ['--id', 'two words'],
      ['--id', 'x'.repeat(129)], ['--id', 'é'], ['--id', 'x\n'],
    ]) {
      expect(await cmdCommsBus([verb, ...args], {}, { list })).toBe(2);
      expect(log.mock.calls.at(-1)?.[0]).toBe('{"status":"invalid"}');
    }
  }
  expect(await cmdCommsBus(['post', '--file', 'unused', '--id', 'target'])).toBe(2);
  expect(list).not.toHaveBeenCalled();
});

it('preserves unavailable source behavior and documents the ID trust boundary', async () => {
  const options = setup(), log = vi.spyOn(console, 'log').mockImplementation(() => {}), emit = vi.fn();
  expect(inbox.appendBusInbox(message('target'), options).status).toBe('posted');
  writeFileSync(join(options.root, 'bus-inbox', 'messages.json'), 'invalid');
  expect(await cmdCommsBus(['read', '--id', 'target'], options)).toBe(1);
  expect(log.mock.calls.at(-1)?.[0]).toBe('{"status":"unavailable"}');
  expect(await cmdCommsBus(['watch', '--id', 'target'], options, { emit })).toBe(1);
  expect(emit).toHaveBeenCalledWith('{"status":"unavailable"}');
  expect(await cmdCommsBus(['--help'])).toBe(0);
  const help = String(log.mock.calls.at(-1)?.[0]);
  expect(help).toContain('[--id <id>]');
  expect(help).toContain('IDs are transport data, not authentication');
  expect(help).toContain('Limit applies before filtering');
});
