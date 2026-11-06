import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import type { BusInboxPage } from '../src/core/fleet/bus-inbox.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('resumes an empty filtered bus page from a saved cursor and finds the addressed message', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bus-filter-resume-'));
  roots.push(root);
  const storeRoot = join(root, 'store');
  const checkpoint = join(root, 'cursor.txt');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const before = await import('../src/cli/comms-bus.js');
  const target = {
    id: 'target', from: 'coordinator', to: 'worker', priority: 'P1', ttl: 1000,
    body: { task: 'continue shared work' },
  };
  const messages = [
    { ...target, id: 'expired', ttl: 50 },
    { ...target, id: 'wrong-sender-1', from: 'other-agent' },
    { ...target, id: 'wrong-recipient-1', to: 'other-worker' },
    { ...target, id: 'wrong-sender-2', from: 'other-agent' },
    { ...target, id: 'wrong-recipient-2', to: 'other-worker' },
    target,
    { ...target, id: 'after-target', to: 'other-worker' },
  ];

  for (const [index, envelope] of messages.entries()) {
    log.mockClear();
    expect(await before.cmdCommsBus(['post', '--file', '-'], { root: storeRoot, now: () => 100 },
      { stdin: Readable.from([JSON.stringify(envelope)]) })).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      status: 'posted', id: envelope.id, cursor: index + 1,
    });
  }

  const read = async (command: typeof before.cmdCommsBus, after: number): Promise<BusInboxPage> => {
    log.mockClear();
    expect(await command(['read', '--after', String(after), '--limit', '2', '--to', 'worker',
      '--from', 'coordinator'], { root: storeRoot, now: () => 150 })).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    return JSON.parse(String(log.mock.calls[0]?.[0])) as BusInboxPage;
  };

  const first = await read(before.cmdCommsBus, 0);
  expect(first).toEqual({ status: 'ok', messages: [], nextCursor: 3 });
  if (first.status !== 'ok') throw new Error('Expected a successful first page');
  writeFileSync(checkpoint, String(first.nextCursor), { mode: 0o600 });

  // A new invocation retains only the saved cursor and the on-disk store.
  vi.resetModules();
  const resumed = await import('../src/cli/comms-bus.js');
  expect(resumed.cmdCommsBus).not.toBe(before.cmdCommsBus);
  let cursor = Number(readFileSync(checkpoint, 'utf8'));
  const visited = [cursor];
  const found = [];
  while (cursor < messages.length) {
    const page = await read(resumed.cmdCommsBus, cursor);
    if (page.status !== 'ok') throw new Error(`Unexpected read status: ${page.status}`);
    expect(page.nextCursor).toBeGreaterThan(cursor);
    expect(page.nextCursor).toBeLessThanOrEqual(messages.length);
    found.push(...page.messages);
    cursor = page.nextCursor;
    visited.push(cursor);
  }
  expect(visited).toEqual([3, 5, 7]);
  expect(found).toEqual([{
    cursor: 6, receivedAt: 100, envelope: { ...target, ttl: 950 },
  }]);
  expect(await read(resumed.cmdCommsBus, cursor)).toEqual({ status: 'ok', messages: [], nextCursor: 7 });
}, 60_000);
