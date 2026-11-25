import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetWorkBoard } from '../src/cli/fleet-work-board.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';

it('prints settled results on one row while preserving JSON and the footer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'board-proof-925s-'));
  chmodSync(root, 0o700);
  let now = Date.now();
  const request = (id: string) => {
    expect(appendBusInbox({ id, from: 'fake-requester', to: 'fake-worker', priority: 'P1', ttl: 10_000_000,
      body: { kind: 'work' } }, { root, now: () => now++ }).status).toBe('posted');
  };
  const reply = (id: string, body: unknown) => {
    expect(postBusReply(id, `reply-${id}`, body, { root, now: () => now++ }).outcome).toBe('posted');
  };
  try {
    request('fake-blocked');
    reply('fake-blocked', { blocked: { dependency: 'fake dependency\nINJECTED\u001b[31m' } });
    request('fake-verified');
    reply('fake-verified', { verified: { pr: 7, head: 'fakehead925', tests: '12 passed', artifact: 'fake-report.txt' } });
    request('fake-plain');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdFleetWorkBoard(['--root', root])).toBe(0);
    const lines = log.mock.calls.map(call => String(call[0]));
    expect(lines).toHaveLength(4);
    expect(lines.find(line => line.startsWith('fake-blocked '))).toContain('dependency=fake dependency INJECTED [31m');
    const verified = lines.find(line => line.startsWith('fake-verified '))!;
    expect(verified).toContain('VERIFIED');
    for (const proof of ['pr=7', 'head=fakehead925', 'tests=12 passed', 'artifact=fake-report.txt']) expect(verified).toContain(proof);
    const plain = lines.find(line => line.startsWith('fake-plain '))!;
    expect(plain).toContain(' RECEIVED ');
    expect(plain).not.toMatch(/ dependency=| pr=| head=| tests=| artifact=/);
    expect(lines.at(-1)).toMatch(/^items=3 truncated=no inbox=ok as-of=/);
    expect(lines.join('\n')).not.toContain('\u001b');
    expect(await cmdFleetWorkBoard(['--root', root, '--json'])).toBe(0);
    const board = JSON.parse(String(log.mock.calls.at(-1)![0]));
    const byId = new Map<string, { result?: unknown }>(board.items.map((item: { id: string }) => [item.id, item]));
    expect(byId.get('fake-blocked')?.result).toEqual({ kind: 'blocked', dependency: 'fake dependency\nINJECTED\u001b[31m' });
    expect(byId.get('fake-verified')?.result).toEqual({ kind: 'verified', pr: 7, head: 'fakehead925', tests: '12 passed', artifact: 'fake-report.txt' });
    expect(byId.get('fake-plain')?.result).toBeUndefined();
  } finally {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }
});
afterEach(() => vi.restoreAllMocks());
