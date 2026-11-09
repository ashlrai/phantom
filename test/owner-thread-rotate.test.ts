import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { acceptOwnerInbound, readOwnerCommsStatus, readOwnerThread, sendOwnerReply, type OwnerThreadOptions } from '../src/core/comms/owner-thread.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function fixture() {
  const runsDir = mkdtempSync(join(tmpdir(), 'owner-rotate-')); roots.push(runsDir);
  let calls = 0;
  const options: OwnerThreadOptions = {
    runsDir, busRoot: join(runsDir, 'bus'), capacity: { messages: 10, bytes: 1_048_576 },
    settings: { owners: { desktop: 'local-owner' }, secretHandles: {}, confirmed: true,
      team: [{ channel: 'bus', id: 'local-owner' }] },
    mailbox: { async accept() { return { status: 'accepted' }; } },
    transports: { desktop: { async pull() { return []; }, async deliver() { calls++; return { status: 'sent', reason: 'ok' }; } } },
  };
  const input = (n: number) => ({ channel: 'desktop' as const, senderId: 'local-owner', text: `message ${n}`, idempotencyKey: `message-${n}`, at: 1_700_000_000_000 });
  return { options, input, calls: () => calls, dir: join(runsDir, 'leader') };
}

it('rotates ordered messages and retains inbound and outbound dedupe', async () => {
  const f = fixture();
  for (let n = 1; n <= 25; n++) expect(await acceptOwnerInbound(f.input(n), f.options)).toMatchObject({ status: 'accepted', seq: n });
  const archives = readdirSync(f.dir).filter(name => name.startsWith('owner-thread-archive-')).sort((a, b) => Number(a.split('-')[3]) - Number(b.split('-')[3])).map(name => JSON.parse(readFileSync(join(f.dir, name), 'utf8')) as { messages: Array<{ seq: number }> });
  expect(archives.length).toBeGreaterThan(0);
  const live = readOwnerThread(f.options).messages;
  expect(live.length).toBeLessThanOrEqual(10);
  expect([...archives.flatMap(a => a.messages), ...live].map(m => m.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  expect((await acceptOwnerInbound(f.input(1), f.options)).status).toBe('duplicate');
  expect(readOwnerCommsStatus(f.options).messages).toBe(25);
  expect((await sendOwnerReply({ text: 'answer', idempotencyKey: 'reply-key-1' }, f.options)).status).toBe('sent');
  expect((await sendOwnerReply({ text: 'answer', idempotencyKey: 'reply-key-1' }, f.options)).status).toBe('duplicate');
  for (let n = 26; n <= 40; n++) expect((await acceptOwnerInbound(f.input(n), f.options)).status).toBe('accepted');
  expect((await sendOwnerReply({ text: 'answer', idempotencyKey: 'reply-key-1' }, f.options)).status).toBe('duplicate');
  expect(f.calls()).toBe(1);
  const state = JSON.parse(readFileSync(join(f.dir, 'owner-thread.json'), 'utf8')) as { deliveries: Record<string, string> };
  expect(state.deliveries).toEqual({});
  expect(readOwnerCommsStatus(f.options).messages).toBe(41);
}, 120_000);

it('reads and rotates legacy files and rejects invalid bases', async () => {
  const f = fixture(); mkdirSync(f.dir, { mode: 0o700 });
  const path = join(f.dir, 'owner-thread.json');
  writeFileSync(path, JSON.stringify({ v: 1, threadId: 'owner', messages: [], deliveries: {} }), { mode: 0o600 });
  for (let n = 1; n <= 11; n++) expect((await acceptOwnerInbound(f.input(n), f.options)).status).toBe('accepted');
  expect(readOwnerCommsStatus(f.options).messages).toBe(11);
  writeFileSync(path, JSON.stringify({ v: 1, threadId: 'owner', base: -1, messages: [], deliveries: {} }));
  expect(readOwnerThread(f.options)).toHaveProperty('unavailable', true);
}, 120_000);

it('fails closed on a conflicting archive without changing live state', async () => {
  const f = fixture();
  for (let n = 1; n <= 10; n++) expect((await acceptOwnerInbound(f.input(n), f.options)).status).toBe('accepted');
  const path = join(f.dir, 'owner-thread.json'); const before = readFileSync(path, 'utf8');
  writeFileSync(join(f.dir, 'owner-thread-archive-1-6.json'), '{}', { mode: 0o600 });
  expect((await acceptOwnerInbound(f.input(11), f.options)).status).toBe('unavailable');
  expect(readFileSync(path, 'utf8')).toBe(before);
}, 120_000);
