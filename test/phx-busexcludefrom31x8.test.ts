import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdCommsBus } from '../src/cli/comms-bus.js';
import { validateBusEnvelope, type BusEnvelope, type BusPriority } from '../src/core/fleet/bus-envelope.js';
import { appendBusInbox, listBusInboxAfter, type BusInboxPage } from '../src/core/fleet/bus-inbox.js';

const roots: string[] = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'bus-exclude-'));
  roots.push(root);
  return { root, now: () => 100 };
}
function message(id: string, from: string, to = 'room', priority: BusPriority = 'P1'): BusEnvelope {
  return { id, from, to, priority, ttl: 1000, body: { text: `fake-${id}` } };
}
function receipt(cursor: number, envelope: BusEnvelope) {
  return { cursor, receivedAt: 100, envelope };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

it('excludes exact sender labels from scanned pages and composes with all filters', async () => {
  const options = setup(), log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const rows = [message('self', 'agent'), message('remote', 'Agent'), message('other-room', 'remote', 'other'),
    message('low', 'remote', 'room', 'P3'), message('match', 'remote', 'room', 'P0')];
  rows.forEach(row => expect(appendBusInbox(row, options).status).toBe('posted'));
  const read = async (args: string[]): Promise<BusInboxPage> => {
    expect(await cmdCommsBus(['read', ...args], options)).toBe(0);
    return JSON.parse(String(log.mock.calls.at(-1)?.[0])) as BusInboxPage;
  };
  expect(await read(['--exclude-from', 'agent', '--limit', '2'])).toEqual({
    status: 'ok', messages: [receipt(2, rows[1]!)], nextCursor: 2,
  });
  expect(await read(['--exclude-from', 'agent', '--to', 'room', '--from', 'remote', '--priority', 'P0', '--id', 'match']))
    .toEqual({ status: 'ok', messages: [receipt(5, rows[4]!)], nextCursor: 5 });
  expect(await read(['--exclude-from', 'remote', '--from', 'remote']))
    .toEqual({ status: 'ok', messages: [], nextCursor: 5 });
  expect(await read(['--exclude-from', 'Agent'])).toEqual({
    status: 'ok', messages: [receipt(1, rows[0]!), receipt(3, rows[2]!), receipt(4, rows[3]!), receipt(5, rows[4]!)], nextCursor: 5,
  });
});

it('advances an all-excluded page and resumes at the next remote envelope', async () => {
  const options = setup(), log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const self = message('self', 'agent'), remote = message('remote', 'peer');
  expect(appendBusInbox(self, options).status).toBe('posted');
  expect(await cmdCommsBus(['read', '--exclude-from', 'agent', '--limit', '1'], options)).toBe(0);
  const first = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as BusInboxPage;
  expect(first).toEqual({ status: 'ok', messages: [], nextCursor: 1 });
  expect(appendBusInbox(remote, options).status).toBe('posted');
  expect(await cmdCommsBus(['read', '--exclude-from', 'agent', '--after', '1', '--limit', '1'], options)).toBe(0);
  expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({ status: 'ok', messages: [receipt(2, remote)], nextCursor: 2 });
});

it('bounded watch resumes after an excluded page and emits a newly posted remote message', async () => {
  vi.useFakeTimers();
  const options = setup(), pages: BusInboxPage[] = [], list = vi.fn(listBusInboxAfter);
  const self = message('self', 'agent'), remote = message('remote', 'peer', 'room', 'P0');
  expect(appendBusInbox(self, options).status).toBe('posted');
  const run = cmdCommsBus(['watch', '--exclude-from', 'agent', '--to', 'room', '--from', 'peer', '--priority', 'P0',
    '--limit', '1', '--interval-ms', '100', '--max-pages', '2'], options,
  { list, emit: json => pages.push(JSON.parse(json) as BusInboxPage) });
  expect(pages).toEqual([{ status: 'ok', messages: [], nextCursor: 1 }]);
  expect(appendBusInbox(remote, options).status).toBe('posted');
  await vi.advanceTimersByTimeAsync(100);
  expect(await run).toBe(0);
  expect(pages).toEqual([{ status: 'ok', messages: [], nextCursor: 1 },
    { status: 'ok', messages: [receipt(2, remote)], nextCursor: 2 }]);
  expect(list.mock.calls.map(call => call[0])).toEqual([0, 1]);
  expect(vi.getTimerCount()).toBe(0);
});

it('accepts inline option-looking labels and validates labels like envelopes', async () => {
  const options = setup(), log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const self = message('self', '--from'), remote = message('remote', 'peer');
  [self, remote].forEach(row => expect(appendBusInbox(row, options).status).toBe('posted'));
  expect(await cmdCommsBus(['read', '--exclude-from=--from'], options)).toBe(0);
  expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({ status: 'ok', messages: [receipt(2, remote)], nextCursor: 2 });
  for (const label of ['a', '-agent', 'a'.repeat(128), 'a'.repeat(129), 'two words', 'é', 'x\n', '']) {
    const valid = validateBusEnvelope({ id: label, from: label, to: label, priority: 'P3', ttl: 1, body: null }).ok;
    expect(await cmdCommsBus(['read', `--exclude-from=${label}`], options)).toBe(valid ? 0 : 2);
  }
});

it('rejects missing, duplicate, malformed and unsupported arguments before polling', async () => {
  const options = setup(), log = vi.spyOn(console, 'log').mockImplementation(() => {}), list = vi.fn(listBusInboxAfter);
  for (const verb of ['read', 'watch']) {
    for (const args of [['--exclude-from'], ['--exclude-from='], ['--exclude-from', '--to', 'room'],
      ['--exclude-from', '--from=agent'], ['--to', '--exclude-from=agent'],
      ['--exclude-from', 'a', '--exclude-from=b'], ['--exclude-from=a', '--exclude-from', 'b'],
      ['--exclude-from', 'two words'], ['--exclude-from', 'a'.repeat(129)]]) {
      expect(await cmdCommsBus([verb, ...args], options, { list })).toBe(2);
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({ status: 'invalid' });
    }
  }
  for (const args of [['post', '--file', 'fake', '--exclude-from', 'agent'], ['post', '--exclude-from=agent'],
    ['status', '--exclude-from', 'agent'], ['status', '--exclude-from=agent']]) {
    expect(await cmdCommsBus(args, options)).toBe(2);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({ status: 'invalid' });
  }
  expect(list).not.toHaveBeenCalled();
});

it('documents exclusion as a routing label and the cursor semantics', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['--help'])).toBe(0);
  const help = String(log.mock.calls[0]?.[0]);
  expect(help).toContain('--exclude-from omits envelopes with that sender routing label');
  expect(help).toContain('routing labels do not confer authenticated identity');
  expect(help).toContain('Limit applies before filtering');
});
