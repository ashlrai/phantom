import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('resumes a shared bus after reconstructing the CLI and storage modules', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fake-bus-restart-'));
  roots.push(root);
  const original = {
    id: 'fake-original', from: 'fake-agent-alpha', to: 'fake-agent-beta',
    priority: 'P1', ttl: 1000, body: { text: 'fake first message' },
  };
  const expiring = {
    id: 'fake-expiring', from: 'fake-agent-alpha', to: 'fake-agent-beta',
    priority: 'P2', ttl: 50, body: { text: 'fake expiring message' },
  };
  const second = {
    id: 'fake-second', from: 'fake-agent-beta', to: 'fake-agent-alpha',
    priority: 'P0', ttl: 500, body: { text: 'fake reply' },
  };
  const originalFile = join(root, 'original.json');
  const expiringFile = join(root, 'expiring.json');
  const secondFile = join(root, 'second.json');
  const conflictFile = join(root, 'conflict.json');
  for (const [file, envelope] of [
    [originalFile, original], [expiringFile, expiring], [secondFile, second],
    [conflictFile, { ...original, body: { text: 'fake changed message' } }],
  ] as const) writeFileSync(file, JSON.stringify(envelope), { mode: 0o600 });

  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const before = await import('../src/cli/comms-bus.js');
  const beforeStore = await import('../src/core/fleet/bus-inbox.js');
  const run = async (command: typeof before.cmdCommsBus, args: string[], now: number, exit: number) => {
    log.mockClear();
    expect(await command(args, { root, now: () => now })).toBe(exit);
    expect(log).toHaveBeenCalledTimes(1);
    return JSON.parse(String(log.mock.calls[0]?.[0]));
  };

  expect(await run(before.cmdCommsBus, ['post', '--file', originalFile], 100, 0))
    .toEqual({ status: 'posted', id: original.id, cursor: 1 });
  expect(await run(before.cmdCommsBus, ['post', '--file', expiringFile], 100, 0))
    .toEqual({ status: 'posted', id: expiring.id, cursor: 2 });
  const firstPage = await run(before.cmdCommsBus, ['read', '--limit', '1'], 100, 0);
  expect(firstPage).toEqual({
    status: 'ok', messages: [{ cursor: 1, receivedAt: 100, envelope: original }], nextCursor: 1,
  });
  const savedCursor: number = firstPage.nextCursor;

  // Drop the loaded module graph as a process restart would; retain only the cursor and disk root.
  vi.resetModules();
  const after = await import('../src/cli/comms-bus.js');
  const afterStore = await import('../src/core/fleet/bus-inbox.js');
  expect(after.cmdCommsBus).not.toBe(before.cmdCommsBus);
  expect(afterStore.listBusInboxAfter).not.toBe(beforeStore.listBusInboxAfter);

  const resumed = await run(after.cmdCommsBus, ['read', '--after', String(savedCursor), '--limit', '1'], 150, 0);
  expect(resumed).toEqual({ status: 'ok', messages: [], nextCursor: 2 });
  expect(await run(after.cmdCommsBus, ['post', '--file', secondFile], 150, 0))
    .toEqual({ status: 'posted', id: second.id, cursor: 3 });
  const reply = await run(after.cmdCommsBus, ['read', '--after', String(resumed.nextCursor), '--limit', '1'], 150, 0);
  expect(reply).toEqual({
    status: 'ok', messages: [{ cursor: 3, receivedAt: 150, envelope: second }], nextCursor: 3,
  });
  expect(await run(after.cmdCommsBus, ['read', '--after', String(reply.nextCursor)], 150, 0))
    .toEqual({ status: 'ok', messages: [], nextCursor: 3 });

  expect(await run(after.cmdCommsBus, ['post', '--file', originalFile], 150, 0))
    .toEqual({ status: 'duplicate', id: original.id, cursor: 1 });
  expect(await run(after.cmdCommsBus, ['post', '--file', conflictFile], 150, 1))
    .toEqual({ status: 'conflict' });
  expect(await run(after.cmdCommsBus, ['read'], 150, 0)).toEqual({
    status: 'ok',
    messages: [
      { cursor: 1, receivedAt: 100, envelope: { ...original, ttl: 950 } },
      { cursor: 3, receivedAt: 150, envelope: second },
    ],
    nextCursor: 3,
  });
}, 60_000);
