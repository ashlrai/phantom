import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdMason } from '../src/cli/mason-thread.js';
import { MASON_THREAD_SCHEMA, masonThreadText, readMasonThread } from '../src/core/comms/mason-thread.js';
import { acceptOwnerInbound, sendOwnerReply, type OwnerThreadOptions } from '../src/core/comms/owner-thread.js';
import type { OrderTraceV1 } from '../src/core/fleet/order-trace.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

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

it('keeps only the [since, before) window across owner and inbox sightings', async () => {
  const f = fixture();
  const dir = join(f.runsDir, 'leader'); mkdirSync(dir, { recursive: true });
  await f.inbound('imessage', 'key-older', 'older request please', NOW - 300_000);
  await f.inbound('desktop', 'key-boundary', 'boundary request please', NOW - 120_000);
  await f.inbound('imessage', 'key-newer', 'newer request please', NOW - 60_000);
  const iso = (ms: number) => new Date(ms).toISOString();
  writeFileSync(join(dir, 'MASON-INBOX.md'),
    `${iso(NOW - 200_000)} [src:telegram id:inbox-older] inbox older note\n` +
    `${iso(NOW - 30_000)} [src:telegram id:inbox-newer] inbox newer note\n`);
  const beforeMs = NOW - 120_000;
  const thread = await readMasonThread({ runsDir: f.runsDir, busRoot: join(f.runsDir, 'bus'), owner: f.owner,
    sinceMs: NOW - 86_400_000, beforeMs, now: NOW, trace: noTrace });
  expect(thread.before).toBe(iso(beforeMs));
  expect(thread.items.map(i => i.text)).toEqual(['older request please', 'inbox older note']);
});

it('drops a sighting stamped exactly at the ceiling and echoes before only when given', async () => {
  const f = fixture();
  await f.inbound('imessage', 'key-edge', 'edge request please', NOW - 120_000);
  await f.inbound('imessage', 'key-inside', 'inside request please', NOW - 120_001);
  const beforeMs = NOW - 120_000;
  const bounded = await readMasonThread({ runsDir: f.runsDir, busRoot: join(f.runsDir, 'bus'), owner: f.owner,
    sinceMs: NOW - 86_400_000, beforeMs, now: NOW, trace: noTrace });
  expect(bounded.items.map(i => i.text)).toEqual(['inside request please']);
  const unbounded = await f.read();
  expect(unbounded.before).toBeUndefined();
  expect(unbounded.items.map(i => i.text)).toEqual(['inside request please', 'edge request please']);
});

it('filters outbound replies by the same ceiling and reads an inverted window as honest empty', async () => {
  const f = fixture();
  await f.inbound('imessage', 'key-reply-src', 'please answer this', NOW - 300_000);
  await sendOwnerReply({ text: 'Answering now.', idempotencyKey: 'reply-key-before' }, f.owner);
  const beforeMs = NOW - 120_000;
  const bounded = await readMasonThread({ runsDir: f.runsDir, busRoot: join(f.runsDir, 'bus'), owner: f.owner,
    sinceMs: NOW - 86_400_000, beforeMs, now: NOW, trace: noTrace });
  expect(bounded.items.map(i => [i.dir, i.text])).toEqual([['in', 'please answer this']]);
  const inverted = await readMasonThread({ runsDir: f.runsDir, busRoot: join(f.runsDir, 'bus'), owner: f.owner,
    sinceMs: NOW - 60_000, beforeMs, now: NOW, trace: noTrace });
  expect(inverted.items).toEqual([]);
});

it('slices the merged thread by channel, keeping a two-channel request whole', async () => {
  const f = fixture();
  await f.inbound('imessage', 'key-slice-1', 'Ship the docs fix', NOW - 300_000);
  await f.inbound('desktop', 'key-slice-2', 'ship the  docs fix', NOW - 290_000);
  await f.inbound('imessage', 'key-slice-3', 'Check the inbox please', NOW - 200_000);
  const base = { runsDir: f.runsDir, busRoot: join(f.runsDir, 'bus'), owner: f.owner, sinceMs: NOW - 86_400_000, now: NOW, trace: noTrace };
  const byDesktop = await readMasonThread({ ...base, channel: 'desktop' });
  expect(byDesktop.items.map(i => i.text)).toEqual(['Ship the docs fix']);
  expect(byDesktop.items[0]).toMatchObject({ channel: 'imessage', also_on: ['desktop'] });
  const byImessage = await readMasonThread({ ...base, channel: 'imessage' });
  expect(byImessage.items.map(i => i.text)).toEqual(['Ship the docs fix', 'Check the inbox please']);
  expect((await readMasonThread({ ...base, channel: 'slack' })).items).toEqual([]);
});

it('slices the merged thread by direction and matches a reply under every channel it was sent to', async () => {
  const f = fixture();
  await f.inbound('imessage', 'key-dir-1', 'please answer this', NOW - 300_000);
  await sendOwnerReply({ text: 'Answering now.', idempotencyKey: 'reply-dir' }, f.owner);
  const base = { runsDir: f.runsDir, busRoot: join(f.runsDir, 'bus'), owner: f.owner, sinceMs: NOW - 86_400_000, now: NOW, trace: noTrace };
  const inboundOnly = await readMasonThread({ ...base, direction: 'inbound' });
  expect(inboundOnly.items.map(i => i.dir)).toEqual(['in']);
  const outboundOnly = await readMasonThread({ ...base, direction: 'outbound' });
  expect(outboundOnly.items.map(i => [i.dir, i.channel, i.also_on, i.text])).toEqual([['out', 'imessage', ['desktop'], 'Answering now.']]);
  // The reply fanned out to imessage and desktop: --channel desktop keeps it.
  const replyOnDesktop = await readMasonThread({ ...base, channel: 'desktop', direction: 'outbound' });
  expect(replyOnDesktop.items.map(i => i.text)).toEqual(['Answering now.']);
});

it('slices the merged thread by contains over the printed text', async () => {
  const f = fixture();
  await f.inbound('imessage', 'key-find-1', 'Ship the docs fix', NOW - 300_000);
  await f.inbound('imessage', 'key-find-2', 'Check the   inbox please', NOW - 200_000);
  const base = { runsDir: f.runsDir, busRoot: join(f.runsDir, 'bus'), owner: f.owner, sinceMs: NOW - 86_400_000, now: NOW, trace: noTrace };
  const found = await readMasonThread({ ...base, contains: 'DOCS fix' });
  expect(found.items.map(i => i.text)).toEqual(['Ship the docs fix']);
  // Whitespace collapses on both sides, the same rule every comms --contains applies.
  const spaced = await readMasonThread({ ...base, contains: 'the   inbox' });
  expect(spaced.items).toHaveLength(1);
  expect(spaced.items[0]!.text).toContain('inbox');
  expect((await readMasonThread({ ...base, contains: 'nothing matches this' })).items).toEqual([]);
});

it('parses --before on the thread command and refuses a bad value', async () => {
  const f = fixture();
  await f.inbound('imessage', 'key-cli-old', 'cli older note', NOW - 300_000);
  await f.inbound('imessage', 'key-cli-new', 'cli newer note', NOW - 60_000);
  const deps = { runsDir: f.runsDir, busRoot: join(f.runsDir, 'bus'), owner: f.owner, now: NOW, trace: noTrace };
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const code = await cmdMason(['thread', '--json',
    '--since', '2026-11-18T12:00:00.000Z', '--before', '2026-11-19T11:58:00.000Z'], deps);
  expect(code).toBe(0);
  const thread = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  expect(thread.before).toBe('2026-11-19T11:58:00.000Z');
  expect(thread.items.map((i: { text: string }) => i.text)).toEqual(['cli older note']);
  expect(await cmdMason(['thread', '--before', 'soon'], deps)).toBe(2);
});

it('parses --channel, --direction and --contains on the thread command and refuses bad values', async () => {
  const f = fixture();
  await f.inbound('imessage', 'key-cli-f1', 'cli channel note', NOW - 300_000);
  await f.inbound('desktop', 'key-cli-f2', 'cli desktop note', NOW - 200_000);
  await sendOwnerReply({ text: 'cli reply note', idempotencyKey: 'reply-cli-f' }, f.owner);
  const deps = { runsDir: f.runsDir, busRoot: join(f.runsDir, 'bus'), owner: f.owner, now: NOW, trace: noTrace };
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const read = async (args: string[]) => {
    log.mockClear();
    // An explicit --since keeps the read inside the fixture window whatever the real clock says.
    expect(await cmdMason(['thread', '--json', '--since', '2026-11-18T00:00:00.000Z', ...args], deps)).toBe(0);
    return JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  };
  // The reply went to the desktop inbound, so it is a desktop outbound item.
  expect((await read(['--channel', 'desktop'])).items.map((i: { text: string }) => i.text))
    .toEqual(['cli desktop note', 'cli reply note']);
  expect((await read(['--direction', 'outbound'])).items.map((i: { text: string }) => i.text))
    .toEqual(['cli reply note']);
  expect((await read(['--contains', 'CHANNEL'])).items.map((i: { text: string }) => i.text))
    .toEqual(['cli channel note']);
  expect((await read(['--channel', 'slack'])).items).toEqual([]);
  expect(await cmdMason(['thread', '--channel', 'Bad Channel'], deps)).toBe(2);
  expect(await cmdMason(['thread', '--direction', 'sideways'], deps)).toBe(2);
  expect(await cmdMason(['thread', '--contains', '   '], deps)).toBe(2);
  expect(await cmdMason(['thread', '--contains', '--json'], deps)).toBe(2);
});
