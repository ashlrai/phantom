import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { MASON_THREAD_SCHEMA, masonThreadText, readMasonThread } from '../src/core/comms/mason-thread.js';
import { acceptOwnerInbound, sendOwnerReply, type OwnerThreadOptions } from '../src/core/comms/owner-thread.js';
import type { OrderTraceV1 } from '../src/core/fleet/order-trace.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

const NOW = Date.parse('2026-11-19T12:00:00Z');
const noTrace = async (): Promise<OrderTraceV1> => ({ v: 1, generatedAt: '', sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy', queue: 'healthy' }, orders: [] });

function fixture() {
  const runsDir = mkdtempSync(join(tmpdir(), 'mason-thread-')); roots.push(runsDir);
  const owner: OwnerThreadOptions = {
    runsDir, busRoot: join(runsDir, 'bus'), now: () => NOW,
    settings: { owners: { imessage: 'mason', desktop: 'mason' }, secretHandles: {}, imessageBridge: 'loopback', confirmed: true, team: [{ channel: 'bus', id: 'mason' }] },
    mailbox: { async accept() { return { status: 'accepted' }; } },
    transports: { desktop: { async pull() { return []; }, async deliver() { return { status: 'sent', reason: 'ok' }; } } },
  };
  const read = (sinceMs = NOW - 86_400_000) => readMasonThread({ runsDir, busRoot: join(runsDir, 'bus'), owner, sinceMs, now: NOW, trace: noTrace });
  const inbound = (channel: 'imessage' | 'desktop', key: string, text: string, at: number) =>
    acceptOwnerInbound({ channel, senderId: 'mason', text, idempotencyKey: key, at }, owner);
  return { runsDir, owner, read, inbound };
}

it('shows "Nothing yet." for an empty thread', async () => {
  const f = fixture();
  const thread = await f.read();
  expect(thread).toMatchObject({ schema: MASON_THREAD_SCHEMA, items: [] });
  expect(masonThreadText({ ...thread, gaps: [] })).toBe('Nothing yet.');
});

it('merges the same request seen on two channels into one item', async () => {
  const f = fixture();
  expect((await f.inbound('imessage', 'phone-key-1', 'Ship the docs fix', NOW - 120_000)).status).toBe('accepted');
  expect((await f.inbound('desktop', 'desk-key-1', 'ship the  docs fix', NOW - 90_000)).status).toBe('accepted');
  const thread = await f.read();
  expect(thread.items).toHaveLength(1);
  expect(thread.items[0]).toMatchObject({ dir: 'in', channel: 'imessage', also_on: ['desktop'], state: 'RECEIVED', job_ids: [] });
});

it('tags a message with no reply yet as Received and keeps the leader reply after it', async () => {
  const f = fixture();
  await f.inbound('desktop', 'desk-key-2', 'Any news on the queue?', NOW - 60_000);
  const before = await f.read();
  expect(before.items.map(i => i.state)).toEqual(['RECEIVED']);
  expect(masonThreadText(before)).toContain('Received');
  await sendOwnerReply({ text: 'Looking now.', idempotencyKey: 'reply-key-2' }, f.owner);
  const after = await f.read();
  expect(after.items.map(i => i.dir)).toEqual(['in', 'out']);
  expect(after.items[1]).toMatchObject({ state: null });
});

it('links jobs from the inbox order trace and reports their state', async () => {
  const f = fixture();
  const dir = join(f.runsDir, 'leader'); mkdirSync(dir, { recursive: true });
  const iso = new Date(NOW - 300_000).toISOString();
  writeFileSync(join(dir, 'MASON-INBOX.md'), `${iso} [src:telegram id:abc123] [also:slack] Fix the login page\n`);
  const [entry] = (await import('../src/core/fleet/mason-inbox.js')).parseInbox(`${iso} [src:telegram id:abc123] [also:slack] Fix the login page\n`);
  const trace = async (): Promise<OrderTraceV1> => ({ ...(await noTrace()), orders: [{ at: entry!.at, source: entry!.source, key: 'k', jobs: [{ id: 'RQ-ONE', lane: null, state: 'launched', url: null }] }] });
  const thread = await readMasonThread({ runsDir: f.runsDir, busRoot: join(f.runsDir, 'bus'), owner: f.owner, sinceMs: NOW - 86_400_000, now: NOW, trace });
  expect(thread.items).toHaveLength(1);
  expect(thread.items[0]).toMatchObject({ channel: 'telegram', also_on: ['slack'], state: 'RUNNING', job_ids: ['RQ-ONE'] });
});

it('says unknown when the stores cannot be read', async () => {
  const f = fixture();
  const dir = join(f.runsDir, 'leader'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'owner-thread.json'), 'not json');
  const thread = await f.read();
  expect(thread.gaps.join(' ')).toContain('Owner thread could not be read');
});
