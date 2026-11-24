import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdCommsOwner, cmdCommsOwnerStatus } from '../src/cli/comms-owner-thread.js';
import { createLeaderMailbox } from '../src/core/comms/leader-mailbox.js';
import { fixedOwnerConfigDir, fixedOwnerRunsDir, loadOwnerThreadSettings, type OwnerChannelTransport, type OwnerDelivery, type OwnerThreadSettings } from '../src/core/comms/owner-channel.js';
import { liveOwnerTransports, proveOwnerDirectMessage, resolveLiveEmailRecipient, resolveLiveIMessageHandle, resolveLiveSlackOwnerId } from '../src/core/comms/owner-live-transport.js';
import { acceptOwnerInbound, postOwnerNotice, pullOwnerChannel, readOwnerAwaitingReplies, readOwnerCommsStatus, readOwnerThread, readOwnerUndeliveredReplies, sendOwnerHello, sendOwnerReply, type OwnerThreadOptions } from '../src/core/comms/owner-thread.js';
import { useAccountHomeForTest } from '../src/core/real-home.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

const settings: OwnerThreadSettings = {
  owners: {
    desktop: 'local-owner', telegram: 'telegram:100', email: 'email:owner@example.com',
    imessage: 'owner@example.com', slack: 'U0123456789',
  },
  secretHandles: { telegram: 'phm_TELEGRAM_BOT_TOKEN', email: 'phm_EMAIL_CREDENTIAL', slack: 'phm_SLACK_BOT_TOKEN' },
  imessageBridge: 'loopback',
  confirmed: true,
  team: [
    { channel: 'bus', id: 'local-owner' },
    { channel: 'telegram', id: 'telegram:100' },
    { channel: 'email', id: 'email:owner@example.com' },
    { channel: 'imessage', id: 'owner@example.com' },
    { channel: 'slack', id: 'U0123456789' },
  ],
};

function fixture(overrides: Partial<OwnerThreadOptions> = {}) {
  const runsDir = mkdtempSync(join(tmpdir(), 'owner-thread-'));
  roots.push(runsDir);
  const calls: string[] = [];
  const sent: OwnerDelivery[] = [];
  const transport = (name: string): OwnerChannelTransport => ({
    async pull() { calls.push(`pull:${name}`); return []; },
    async deliver(input) {
      calls.push(`deliver:${name}`);
      if (sent.some(row => row.idempotencyKey === input.idempotencyKey)) return { status: 'duplicate', reason: 'dup' };
      sent.push(input);
      return { status: 'sent', reason: 'ok' };
    },
  });
  const seen = new Set<string>();
  const options: OwnerThreadOptions = {
    runsDir, busRoot: join(runsDir, 'bus'), now: () => 1_700_000_000_000,
    settings, halted: false, paused: false,
    transports: { desktop: transport('desktop'), telegram: transport('telegram'), email: transport('email'), imessage: transport('imessage'), slack: transport('slack') },
    mailbox: { async accept(message) {
      calls.push(`mailbox:${message.idempotencyKey}`);
      if (seen.has(message.idempotencyKey)) return { status: 'duplicate' };
      seen.add(message.idempotencyKey);
      return { status: 'accepted', requestId: message.idempotencyKey };
    } },
    ...overrides,
  };
  return { options, calls, sent };
}

describe('owner thread', () => {
  it('keeps every channel in one admission-ordered thread and preserves timestamps', async () => {
    const { options } = fixture();
    await acceptOwnerInbound({ channel: 'telegram', senderId: 'telegram:100', text: 'first', idempotencyKey: 'telegram-msg-1', at: 1_700_000_003_000 }, options);
    await acceptOwnerInbound({ channel: 'email', senderId: 'email:owner@example.com', text: 'second', idempotencyKey: 'email-msg-0002', at: 1_700_000_001_000 }, options);
    await acceptOwnerInbound({ channel: 'slack', senderId: 'U0123456789', text: 'third', idempotencyKey: 'slack-msg-0003', at: 1_700_000_002_000, channelRef: 'T123/C123/1.2' }, options);
    const view = readOwnerThread(options);
    expect(view.messages.map(message => [message.seq, message.channel, message.at])).toEqual([
      [1, 'telegram', '2023-11-14T22:13:23.000Z'],
      [2, 'email', '2023-11-14T22:13:21.000Z'],
      [3, 'slack', '2023-11-14T22:13:22.000Z'],
    ]);
  });

  it('dedupes a repeated idempotency key and does not call the mailbox again', async () => {
    const { options, calls } = fixture();
    const input = { channel: 'telegram' as const, senderId: 'telegram:100', text: 'once', idempotencyKey: 'telegram-msg-1', at: 1_700_000_000_000 };
    expect(await acceptOwnerInbound(input, options)).toEqual({ status: 'accepted', seq: 1, idempotencyKey: 'telegram-msg-1' });
    expect((await acceptOwnerInbound(input, options)).status).toBe('duplicate');
    expect(calls.filter(call => call.startsWith('mailbox:'))).toEqual(['mailbox:telegram-msg-1']);
    expect(readOwnerThread(options).messages).toHaveLength(1);
  });

  it('drops senders who are not the configured owner and never fans a reply to anyone else', async () => {
    const { options, calls, sent } = fixture();
    expect((await acceptOwnerInbound({ channel: 'telegram', senderId: 'telegram:999', text: 'nope', idempotencyKey: 'telegram-outsider', at: 1_700_000_000_000 }, options)).status).toBe('refused');
    expect(calls).toEqual([]);
    await acceptOwnerInbound({ channel: 'telegram', senderId: 'telegram:100', text: 'hello', idempotencyKey: 'telegram-msg-1', at: 1_700_000_000_000 }, options);
    const reply = await sendOwnerReply({ text: 'answer', idempotencyKey: 'reply-owner-01' }, options);
    expect(reply.deliveries?.map(row => row.channel)).toEqual(['telegram', 'desktop']);
    expect(sent.map(row => row.ownerId)).toEqual(['telegram:100', 'local-owner']);
    expect(calls.filter(call => call.startsWith('deliver:'))).toEqual(['deliver:telegram', 'deliver:desktop']);
  });

  it('fans a reply out once and treats the retry as a duplicate', async () => {
    const { options, sent } = fixture();
    await acceptOwnerInbound({ channel: 'email', senderId: 'email:owner@example.com', text: 'question', idempotencyKey: 'email-msg-0001', at: 1_700_000_000_000 }, options);
    expect((await sendOwnerReply({ text: 'answer', idempotencyKey: 'reply-owner-01' }, options)).status).toBe('sent');
    expect((await sendOwnerReply({ text: 'answer', idempotencyKey: 'reply-owner-01' }, options)).status).toBe('duplicate');
    expect(sent).toHaveLength(2);
    expect(readOwnerThread(options).messages.filter(message => message.direction === 'outbound')).toHaveLength(1);
  });

  it('joins per-channel delivery receipts into the thread read and the CLI line', async () => {
    const { options } = fixture();
    options.transports = {
      ...options.transports,
      telegram: { async pull() { return []; }, async deliver() { return { status: 'refused' as const, reason: 'unused' }; } },
    };
    await acceptOwnerInbound({ channel: 'telegram', senderId: 'telegram:100', text: 'hello', idempotencyKey: 'telegram-msg-1', at: 1_700_000_000_000 }, options);
    expect((await sendOwnerReply({ text: 'answer', idempotencyKey: 'reply-owner-01' }, options)).status).toBe('partial');
    const view = readOwnerThread(options);
    const outbound = view.messages.find(message => message.direction === 'outbound')!;
    const inbound = view.messages.find(message => message.direction === 'inbound')!;
    expect(view.receipts[outbound.id]).toEqual({
      desktop: { state: 'delivered' },
      telegram: { state: 'failed', reason: 'Channel transport refused the owner reply.' },
    });
    expect(view.receipts[inbound.id]).toBeUndefined();
    const lines: string[] = [];
    const write = console.log;
    console.log = (line?: unknown) => { lines.push(String(line)); };
    try { expect(await cmdCommsOwner(['thread'], options)).toBe(0); } finally { console.log = write; }
    expect(lines[0]).toContain('[desktop:delivered telegram:failed]');
    expect(lines[0]).not.toContain('inbound [');
  });

  it('reports empty receipts when the thread is unavailable', () => {
    const { options } = fixture();
    mkdirSync(join(options.runsDir, 'leader'), { recursive: true });
    writeFileSync(join(options.runsDir, 'leader', 'owner-thread.json'), 'not json', { mode: 0o600 });
    const view = readOwnerThread(options);
    expect('unavailable' in view).toBe(true);
    expect(view.receipts).toEqual({});
  });

  it('marks live inbound messages no recorded reply cites until one does', async () => {
    const { options } = fixture();
    await acceptOwnerInbound({ channel: 'telegram', senderId: 'telegram:100', text: 'first', idempotencyKey: 'telegram-msg-1', at: 1_700_000_000_000 }, options);
    await acceptOwnerInbound({ channel: 'email', senderId: 'email:owner@example.com', text: 'second', idempotencyKey: 'email-msg-0002', at: 1_700_000_001_000 }, options);
    expect(readOwnerThread(options).awaitingReply).toEqual(['m1', 'm2']);
    expect(readOwnerCommsStatus(options).awaitingReply).toBe(2);
    await sendOwnerReply({ text: 'answer first', replyTo: 'telegram-msg-1', idempotencyKey: 'reply-owner-01' }, options);
    expect(readOwnerThread(options).awaitingReply).toEqual(['m2']);
    expect(readOwnerCommsStatus(options).awaitingReply).toBe(1);
    await sendOwnerReply({ text: 'answer second', replyTo: 'email-msg-0002', idempotencyKey: 'reply-owner-02' }, options);
    expect(readOwnerThread(options).awaitingReply).toEqual([]);
    expect(readOwnerCommsStatus(options).awaitingReply).toBe(0);
  });

  it('lists each awaiting inbound with the fields a pending surface needs', async () => {
    const { options } = fixture();
    await acceptOwnerInbound({ channel: 'telegram', senderId: 'telegram:100', text: 'first', idempotencyKey: 'telegram-msg-1', at: 1_700_000_000_000 }, options);
    await acceptOwnerInbound({ channel: 'email', senderId: 'email:owner@example.com', text: 'second', idempotencyKey: 'email-msg-0002', at: 1_700_000_001_000 }, options);
    const read = readOwnerAwaitingReplies({ runsDir: options.runsDir });
    expect(read).toEqual({
      status: 'ok',
      items: [
        { id: 'm1', idempotencyKey: 'telegram-msg-1', channel: 'telegram', at: '2023-11-14T22:13:20.000Z', text: 'first' },
        { id: 'm2', idempotencyKey: 'email-msg-0002', channel: 'email', at: '2023-11-14T22:13:21.000Z', text: 'second' },
      ],
    });
    await sendOwnerReply({ text: 'answer first', replyTo: 'telegram-msg-1', idempotencyKey: 'reply-owner-01' }, options);
    const after = readOwnerAwaitingReplies({ runsDir: options.runsDir });
    expect(after.status === 'ok' && after.items.map(item => item.id)).toEqual(['m2']);
  });

  it('reads an absent thread as an honest empty list and a corrupt one as unavailable', () => {
    const { options } = fixture();
    expect(readOwnerAwaitingReplies({ runsDir: options.runsDir })).toEqual({ status: 'ok', items: [] });
    mkdirSync(join(options.runsDir, 'leader'), { recursive: true });
    writeFileSync(join(options.runsDir, 'leader', 'owner-thread.json'), 'not json', { mode: 0o600 });
    expect(readOwnerAwaitingReplies({ runsDir: options.runsDir })).toEqual({ status: 'unavailable' });
  });

  it('does not let a proactive notice clear the awaiting mark', async () => {
    const { options } = fixture();
    await acceptOwnerInbound({ channel: 'desktop', senderId: 'local-owner', text: 'ping', idempotencyKey: 'desktop-msg-01', at: 1_700_000_000_000 }, options);
    expect((await postOwnerNotice({ text: 'leader line', idempotencyKey: 'notice-owner-01' }, options)).status).toBe('accepted');
    expect(readOwnerThread(options).awaitingReply).toEqual(['m1']);
  });

  it('counts a recorded reply as answered even when every channel refuses it', async () => {
    const { options } = fixture();
    for (const channel of ['desktop', 'telegram', 'email', 'imessage', 'slack'] as const) {
      options.transports![channel] = { async pull() { return []; }, async deliver() { return { status: 'refused' as const, reason: 'fixture refusal' }; } };
    }
    await acceptOwnerInbound({ channel: 'telegram', senderId: 'telegram:100', text: 'hello', idempotencyKey: 'telegram-msg-1', at: 1_700_000_000_000 }, options);
    expect((await sendOwnerReply({ text: 'answer', idempotencyKey: 'reply-owner-01' }, options)).status).toBe('refused');
    expect(readOwnerThread(options).awaitingReply).toEqual([]);
    expect(readOwnerCommsStatus(options).awaitingReply).toBe(0);
  });

  it('reports awaiting reply and message count as unknown when the thread is unreadable', () => {
    const { options } = fixture();
    mkdirSync(join(options.runsDir, 'leader'), { recursive: true });
    writeFileSync(join(options.runsDir, 'leader', 'owner-thread.json'), 'not json', { mode: 0o600 });
    const view = readOwnerThread(options);
    expect('unavailable' in view).toBe(true);
    expect(view.awaitingReply).toBeNull();
    const status = readOwnerCommsStatus(options);
    expect(status.awaitingReply).toBeNull();
    expect(status.messages).toBeNull();
    expect(status.undeliveredReplies).toBeNull();
  });

  it('lists recorded replies whose fanout is not fully delivered', async () => {
    const { options } = fixture();
    options.transports!.telegram = {
      async pull() { return []; },
      async deliver() { return { status: 'refused' as const, reason: 'fixture refusal' }; },
    };
    await acceptOwnerInbound({ channel: 'telegram', senderId: 'telegram:100', text: 'hello', idempotencyKey: 'telegram-msg-1', at: 1_700_000_000_000 }, options);
    // The reply still answers the inbound; only the delivery side is incomplete.
    expect((await sendOwnerReply({ text: 'answer', idempotencyKey: 'reply-owner-01' }, options)).status).toBe('partial');
    expect(readOwnerThread(options).awaitingReply).toEqual([]);
    const read = readOwnerUndeliveredReplies({ runsDir: options.runsDir });
    expect(read).toEqual({
      status: 'ok',
      items: [{
        id: 'm2', idempotencyKey: 'reply-owner-01', replyTo: 'telegram-msg-1',
        at: '2023-11-14T22:13:20.000Z', text: 'answer',
        destinations: [{ channel: 'telegram', state: 'failed', reason: 'Channel transport refused the owner reply.' }],
      }],
    });
    expect(readOwnerCommsStatus(options).undeliveredReplies).toBe(1);
  });

  it('clears the undelivered mark when a resend confirms the destination', async () => {
    const { options } = fixture();
    let refuse = true;
    options.transports!.telegram = {
      async pull() { return []; },
      async deliver() { return refuse ? { status: 'refused' as const, reason: 'fixture refusal' } : { status: 'sent' as const, reason: 'ok' }; },
    };
    await acceptOwnerInbound({ channel: 'telegram', senderId: 'telegram:100', text: 'hello', idempotencyKey: 'telegram-msg-1', at: 1_700_000_000_000 }, options);
    await sendOwnerReply({ text: 'answer', idempotencyKey: 'reply-owner-01' }, options);
    expect(readOwnerUndeliveredReplies({ runsDir: options.runsDir })).toMatchObject({ status: 'ok' });
    const before = readOwnerUndeliveredReplies({ runsDir: options.runsDir });
    expect(before.status === 'ok' && before.items).toHaveLength(1);
    refuse = false;
    // Same reply identity retries only the unconfirmed destination.
    expect((await sendOwnerReply({ text: 'answer', idempotencyKey: 'reply-owner-01' }, options)).status).toBe('sent');
    expect(readOwnerUndeliveredReplies({ runsDir: options.runsDir })).toEqual({ status: 'ok', items: [] });
    expect(readOwnerCommsStatus(options).undeliveredReplies).toBe(0);
  });

  it('reads a destination with no delivery evidence as unknown, never delivered', () => {
    const { options } = fixture();
    mkdirSync(join(options.runsDir, 'leader'), { recursive: true });
    // A reply recorded before the receipt journal (or with it rotated away):
    // desktop kept its sent-mark in the thread, telegram has no evidence at all.
    writeFileSync(join(options.runsDir, 'leader', 'owner-thread.json'), JSON.stringify({
      v: 1, threadId: 'owner',
      messages: [
        { seq: 1, id: 'm1', idempotencyKey: 'telegram-msg-1', channel: 'telegram', senderId: 'telegram:100', direction: 'inbound', at: '2023-11-14T22:13:20.000Z', text: 'hello' },
        { seq: 2, id: 'm2', idempotencyKey: 'reply-owner-01', channel: 'telegram', senderId: 'leader', direction: 'outbound', at: '2023-11-14T22:14:00.000Z', text: 'answer', replyTo: 'telegram-msg-1', fanout: ['telegram', 'desktop'] },
      ],
      deliveries: { 'reply-owner-01:desktop': 'sent' },
    }), { mode: 0o600 });
    const read = readOwnerUndeliveredReplies({ runsDir: options.runsDir });
    expect(read).toEqual({
      status: 'ok',
      items: [{
        id: 'm2', idempotencyKey: 'reply-owner-01', replyTo: 'telegram-msg-1',
        at: '2023-11-14T22:14:00.000Z', text: 'answer',
        destinations: [{ channel: 'telegram', state: 'unknown', reason: null }],
      }],
    });
  });

  it('keeps notices and hellos out of the undelivered read', async () => {
    const { options } = fixture();
    await postOwnerNotice({ text: 'leader line', idempotencyKey: 'notice-owner-01' }, options);
    await sendOwnerHello(options);
    expect(readOwnerUndeliveredReplies({ runsDir: options.runsDir })).toEqual({ status: 'ok', items: [] });
    expect(readOwnerCommsStatus(options).undeliveredReplies).toBe(0);
  });

  it('reads an absent thread as an honest empty list and a corrupt one as unavailable', () => {
    const { options } = fixture();
    expect(readOwnerUndeliveredReplies({ runsDir: options.runsDir })).toEqual({ status: 'ok', items: [] });
    mkdirSync(join(options.runsDir, 'leader'), { recursive: true });
    writeFileSync(join(options.runsDir, 'leader', 'owner-thread.json'), 'not json', { mode: 0o600 });
    expect(readOwnerUndeliveredReplies({ runsDir: options.runsDir })).toEqual({ status: 'unavailable' });
  });

  it('marks unanswered inbound lines in the human thread and status reads', async () => {
    const { options } = fixture();
    await acceptOwnerInbound({ channel: 'desktop', senderId: 'local-owner', text: 'ping', idempotencyKey: 'desktop-msg-01', at: 1_700_000_000_000 }, options);
    const lines: string[] = [];
    const write = console.log;
    console.log = (line?: unknown) => { lines.push(String(line)); };
    try {
      expect(await cmdCommsOwner(['thread'], options)).toBe(0);
      expect(await cmdCommsOwnerStatus(false, options)).toBe(0);
    } finally { console.log = write; }
    expect(lines[0]).toContain('inbound ping [awaiting reply]');
    expect(lines.join('\n')).toContain('awaiting reply: 1');
    await sendOwnerReply({ text: 'answer', idempotencyKey: 'reply-owner-01' }, options);
    const after: string[] = [];
    console.log = (line?: unknown) => { after.push(String(line)); };
    try { await cmdCommsOwner(['thread'], options); } finally { console.log = write; }
    expect(after[0]).not.toContain('awaiting reply');
  });

  it('halts pulls and sends while KILL or pause is on', async () => {
    const active = fixture();
    await acceptOwnerInbound({ channel: 'slack', senderId: 'U0123456789', text: 'ping', idempotencyKey: 'slack-msg-0001', at: 1_700_000_000_000 }, active.options);
    const halted = fixture({ ...active.options, halted: true });
    expect((await pullOwnerChannel('slack', halted.options))[0]?.status).toBe('halted');
    expect((await sendOwnerReply({ text: 'nope', idempotencyKey: 'reply-owner-02' }, halted.options)).status).toBe('halted');
    expect(active.calls.filter(call => call.startsWith('pull:') || call.startsWith('deliver:'))).toEqual([]);
    const paused = fixture({ paused: true });
    expect((await acceptOwnerInbound({ channel: 'desktop', senderId: 'local-owner', text: 'later', idempotencyKey: 'desktop-msg-01', at: 1_700_000_000_000 }, paused.options)).status).toBe('halted');
  });

  it('keeps iMessage text off the bus mirror', async () => {
    const { options } = fixture();
    expect((await acceptOwnerInbound({ channel: 'imessage', senderId: 'owner@example.com', text: 'Synthetic imessage hello', idempotencyKey: 'imessage-msg-1', at: 1_700_000_000_000 }, options)).status).toBe('accepted');
    const listed = listBusInboxAfter(0, 20, { root: options.busRoot, now: options.now });
    expect(listed.status).toBe('ok');
    if (listed.status !== 'ok') return;
    expect(listed.messages[0]?.envelope.body).toEqual({ kind: 'owner-thread', threadId: 'owner', channel: 'imessage', redacted: true });
    expect(JSON.stringify(listed.messages)).not.toContain('Synthetic imessage hello');
    expect(readOwnerThread(options).messages[0]?.text).toBe('Synthetic imessage hello');
  });

  it('plugs an accepted telegram message into the leader inbox once', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'owner-mailbox-'));
    roots.push(runsDir);
    const configDir = join(runsDir, 'config');
    mkdirSync(configDir, { mode: 0o700 });
    writeFileSync(join(configDir, 'agent-network.toml'), `[mason]\nidentities = [{ channel = "telegram", id = "telegram:100" }]\n[team]\nidentities = [{ channel = "telegram", id = "telegram:100" }]\n`, { mode: 0o600 });
    writeFileSync(join(configDir, 'comms.toml'), 'confirmedByMason = true\n', { mode: 0o600 });
    const now = Date.now();
    const options: OwnerThreadOptions = {
      runsDir, busRoot: join(runsDir, 'bus'), now: () => now, settings, halted: false, paused: false,
      mailbox: createLeaderMailbox({ runsDir, configDir, busRoot: join(runsDir, 'bus'), now: () => now }),
    };
    const input = { channel: 'telegram' as const, senderId: 'telegram:100', text: 'Synthetic owner hello', idempotencyKey: 'telegram-msg-1', at: now };
    expect((await acceptOwnerInbound(input, options)).status).toBe('accepted');
    expect((await acceptOwnerInbound(input, options)).status).toBe('duplicate');
    const inbox = readFileSync(join(runsDir, 'leader', 'MASON-INBOX.md'), 'utf8');
    expect(inbox.match(/Synthetic owner hello/g)).toHaveLength(1);
  });

  it('does not echo a raw token stored where a secret handle belongs', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'owner-config-'));
    roots.push(configDir);
    mkdirSync(join(configDir, 'comms'), { mode: 0o700 });
    const planted = ['123456', `${'AA'}${'F'}${'x'.repeat(30)}`].join(':');
    writeFileSync(join(configDir, 'agent-network.toml'), '[mason]\nidentities = [{ channel = "telegram", id = "telegram:100" }]\n[team]\nidentities = []\n', { mode: 0o600 });
    writeFileSync(join(configDir, 'comms.toml'), 'confirmedByMason = false\n', { mode: 0o600 });
    writeFileSync(join(configDir, 'comms', 'owner-adapters.toml'), `[telegram]\nsecretHandle = "${planted}"\n[imessage]\nbridge = "https://example.invalid"\n`, { mode: 0o600 });
    const loaded = loadOwnerThreadSettings(configDir);
    const status = loaded.secretHandles.telegram;
    expect(status).toBeUndefined();
    expect(JSON.stringify(loaded)).not.toContain(planted);
    expect(loaded.imessageBridge).toBe('off');
  });

  it('serves thread and send-owner as JSON without calling a live transport', async () => {
    const { options } = fixture();
    await acceptOwnerInbound({ channel: 'desktop', senderId: 'local-owner', text: 'from the desktop', idempotencyKey: 'desktop-msg-01', at: 1_700_000_000_000 }, options);
    const lines: string[] = [];
    const write = console.log;
    console.log = (line?: unknown) => { lines.push(String(line)); };
    try {
      expect(await cmdCommsOwner(['thread', '--json'], options)).toBe(0);
      expect(await cmdCommsOwnerStatus(true, options)).toBe(0);
      expect(await cmdCommsOwner(['send-owner', '--text', 'desktop reply', '--idempotency-key', 'reply-owner-01', '--json'], options)).toBe(0);
      expect(await cmdCommsOwner(['send-owner'], options)).toBe(2);
    } finally { console.log = write; }
    const thread = JSON.parse(lines[0] ?? '{}') as { schema: string; messages: unknown[] };
    const status = JSON.parse(lines[1] ?? '{}') as { schema: string; adapters: Array<{ secretHandle: string | null }> };
    const sent = JSON.parse(lines[2] ?? '{}') as { status: string };
    expect(thread.schema).toBe('comms.owner-thread.v1');
    expect(thread.messages).toHaveLength(1);
    expect(status.schema).toBe('comms.owner-thread.status.v1');
    expect(status.adapters.every(adapter => adapter.secretHandle === null || adapter.secretHandle.startsWith('phm_'))).toBe(true);
    expect(sent.status).toBe('sent');
  });

  it('keeps email, Slack and iMessage on the account home when HOME is forged', async () => {
    useAccountHomeForTest();
    const forged = mkdtempSync(join(tmpdir(), 'owner-forged-home-'));
    roots.push(forged);
    const outsider = 'outsider@example.invalid';
    const slackId = 'UOUTSIDERATTACKER';
    const handle = 'outsider-imessage-handle';
    writeForgedHome(forged, outsider, slackId, handle);
    vi.stubEnv('HOME', forged);
    vi.stubEnv('ASHLR_CONFIG_DIR', join(forged, '.ashlr'));
    vi.stubEnv('ASHLR_RUNS_DIR', join(forged, '.ashlr-runs'));
    const sent: string[] = [];
    const slack = slackProbe({ id: 'D123', is_im: true }, [slackId, 'U0BOTUSER1']);
    try {
      const account = userInfo().homedir;
      expect(fixedOwnerConfigDir()).toBe(join(account, '.ashlr'));
      expect(fixedOwnerRunsDir()).toBe(join(account, '.ashlr-runs'));
      expect(fixedOwnerConfigDir().startsWith(forged)).toBe(false);
      expect(await resolveLiveEmailRecipient(`email:${outsider}`)).toBeNull();
      expect(resolveLiveSlackOwnerId()).not.toBe(slackId);
      expect(resolveLiveIMessageHandle()).not.toBe(handle);
      const transports = liveOwnerTransports(loadOwnerThreadSettings(join(forged, '.ashlr')), join(forged, '.ashlr-runs'), {
        sendMail: async message => { sent.push(message.to); return { ok: true }; },
        slackCall: slack.call,
      });
      expect((await transports.email!.deliver({ idempotencyKey: 'email-reply-01', text: 'no', ownerId: `email:${outsider}` })).status).toBe('refused');
      expect((await transports.imessage!.deliver({ idempotencyKey: 'imessage-reply-1', text: 'no', ownerId: handle })).status).toBe('refused');
      expect((await transports.slack!.deliver({ idempotencyKey: 'slack-reply-9', text: 'no', ownerId: slackId, channelRef: 'slack:T123:D123:1700000000.000100' })).status).toBe('refused');
      expect(sent).toEqual([]);
      expect(slack.methods).not.toContain('chat.postMessage');
    } finally { vi.unstubAllEnvs(); }
  });

  it('refuses a Slack reply that is not a 1:1 with the owner', async () => {
    const ref = 'slack:T123:D123:1700000000.000100';
    const channel = slackProbe({ id: 'D123', is_im: true }, ['U0123456789', 'U0OTHER01', 'U0THIRD001']);
    expect(await proveOwnerDirectMessage(channel.call, ref, 'U0123456789')).toBe(false);
    const direct = slackProbe({ id: 'D123', is_im: true }, ['U0123456789', 'U0BOTUSER1']);
    expect(await proveOwnerDirectMessage(direct.call, ref, 'U0123456789')).toBe(true);
    const transports = liveOwnerTransports(settings, '/unused', { slackCall: channel.call });
    expect((await transports.slack!.deliver({ idempotencyKey: 'slack-reply-1', text: 'no', ownerId: 'U0123456789', channelRef: ref })).status).toBe('refused');
    expect(channel.methods).not.toContain('chat.postMessage');
    expect(await proveOwnerDirectMessage(slackProbe({ id: 'C123', is_im: false }, ['U0123456789', 'U0BOTUSER1']).call, 'slack:T123:C123:1700000000.000100', 'U0123456789')).toBe(false);
  });

  it('blocks a delivery when KILL is armed after the reply is queued', async () => {
    const home = mkdtempSync(join(tmpdir(), 'owner-kill-'));
    roots.push(home);
    mkdirSync(join(home, '.ashlr'), { mode: 0o700 });
    vi.stubEnv('HOME', home);
    try {
      const { options } = fixture();
      await acceptOwnerInbound({ channel: 'telegram', senderId: 'telegram:100', text: 'queued', idempotencyKey: 'telegram-msg-1', at: 1_700_000_000_000 }, options);
      let desktopCalled = false;
      options.transports!.telegram = { ...options.transports!.telegram!, async deliver() {
        writeFileSync(join(home, '.ashlr', 'KILL'), 'kill switch active\n', { mode: 0o600 });
        return { status: 'sent', reason: 'ok' };
      } };
      options.transports!.desktop = { ...options.transports!.desktop!, async deliver() {
        desktopCalled = true;
        return { status: 'sent', reason: 'ok' };
      } };
      const reply = await sendOwnerReply({ text: 'answer', idempotencyKey: 'reply-owner-01' }, options);
      expect(desktopCalled).toBe(false);
      expect(reply.deliveries?.find(row => row.channel === 'desktop')?.status).toBe('halted');
    } finally { vi.unstubAllEnvs(); }
  });

  it('filters the thread read by channel and since, keeping marks inside the slice', async () => {
    const { options } = fixture();
    await acceptOwnerInbound({ channel: 'telegram', senderId: 'telegram:100', text: 'tg question', idempotencyKey: 'telegram-msg-1', at: 1_700_000_000_000 }, options);
    await acceptOwnerInbound({ channel: 'email', senderId: 'email:owner@example.com', text: 'em ping', idempotencyKey: 'email-msg-0001', at: 1_700_000_100_000 }, options);
    await sendOwnerReply({ text: 'answer', replyTo: 'telegram-msg-1', idempotencyKey: 'reply-owner-01' }, options);
    // m1 telegram inbound, m2 email inbound, m3 outbound reply on telegram at the fixture clock.
    const email = readOwnerThread(options, 200, { channel: 'email' });
    expect(email.messages.map(message => [message.seq, message.channel])).toEqual([[2, 'email']]);
    expect(email.awaitingReply).toEqual(['m2']);
    expect(email.receipts).toEqual({});
    const telegram = readOwnerThread(options, 200, { channel: 'telegram' });
    expect(telegram.messages.map(message => message.channel)).toEqual(['telegram', 'telegram']);
    expect(telegram.awaitingReply).toEqual([]);
    expect(Object.keys(telegram.receipts)).toEqual(['m3']);
    const recent = readOwnerThread(options, 200, { since: 1_700_000_050_000 });
    expect(recent.messages.map(message => message.seq)).toEqual([2]);
    expect(recent.awaitingReply).toEqual(['m2']);
  });

  it('filters the thread read by beforeAt, keeping the [since, before) window and marks inside the slice', async () => {
    const { options } = fixture();
    await acceptOwnerInbound({ channel: 'telegram', senderId: 'telegram:100', text: 'tg question', idempotencyKey: 'telegram-msg-1', at: 1_700_000_000_000 }, options);
    await acceptOwnerInbound({ channel: 'email', senderId: 'email:owner@example.com', text: 'em ping', idempotencyKey: 'email-msg-0001', at: 1_700_000_100_000 }, options);
    await sendOwnerReply({ text: 'answer', replyTo: 'telegram-msg-1', idempotencyKey: 'reply-owner-01' }, options);
    // m1 telegram inbound at T, m2 email inbound at T+100s, m3 outbound reply at the fixture clock (T).
    const before = readOwnerThread(options, 200, { beforeAt: 1_700_000_050_000 });
    expect(before.messages.map(message => message.seq)).toEqual([1, 3]);
    expect(before.awaitingReply).toEqual([]);
    const window = readOwnerThread(options, 200, { since: 1_700_000_050_000, beforeAt: 1_700_000_150_000 });
    expect(window.messages.map(message => message.seq)).toEqual([2]);
    expect(window.awaitingReply).toEqual(['m2']);
    // The ceiling is exclusive where the floor is inclusive: a message recorded exactly at beforeAt drops out.
    const edge = readOwnerThread(options, 200, { beforeAt: 1_700_000_100_000 });
    expect(edge.messages.map(message => message.seq)).toEqual([1, 3]);
    const floor = readOwnerThread(options, 200, { since: 1_700_000_100_000 });
    expect(floor.messages.map(message => message.seq)).toEqual([2]);
  });

  it('serves before-at on the thread CLI and rejects bad values', async () => {
    const { options } = fixture();
    await acceptOwnerInbound({ channel: 'telegram', senderId: 'telegram:100', text: 'tg', idempotencyKey: 'telegram-msg-1', at: 1_700_000_000_000 }, options);
    await acceptOwnerInbound({ channel: 'email', senderId: 'email:owner@example.com', text: 'em', idempotencyKey: 'email-msg-0001', at: 1_700_000_100_000 }, options);
    const lines: string[] = [];
    const write = console.log;
    console.log = (line?: unknown) => { lines.push(String(line)); };
    try {
      // m2 lands exactly at 22:15:00Z — the exclusive ceiling keeps only m1.
      expect(await cmdCommsOwner(['thread', '--before-at', '2023-11-14T22:15:00Z', '--json'], options)).toBe(0);
      expect(await cmdCommsOwner(['thread', '--before-at', 'garbage'], options)).toBe(2);
      expect(await cmdCommsOwner(['thread', '--before-at'], options)).toBe(2);
    } finally { console.log = write; }
    const view = JSON.parse(lines[0] ?? '{}') as { messages: Array<{ seq: number }> };
    expect(view.messages.map(message => message.seq)).toEqual([1]);
  });

  it('serves channel and since filters on the thread CLI and rejects bad values', async () => {
    const { options } = fixture();
    await acceptOwnerInbound({ channel: 'telegram', senderId: 'telegram:100', text: 'tg', idempotencyKey: 'telegram-msg-1', at: 1_700_000_000_000 }, options);
    await acceptOwnerInbound({ channel: 'email', senderId: 'email:owner@example.com', text: 'em', idempotencyKey: 'email-msg-0001', at: 1_700_000_100_000 }, options);
    const lines: string[] = [];
    const write = console.log;
    console.log = (line?: unknown) => { lines.push(String(line)); };
    try {
      expect(await cmdCommsOwner(['thread', '--channel', 'email', '--json'], options)).toBe(0);
      expect(await cmdCommsOwner(['thread', '--since', '2023-11-14T22:14:00Z', '--json'], options)).toBe(0);
      expect(await cmdCommsOwner(['thread', '--channel', 'bogus'], options)).toBe(2);
      expect(await cmdCommsOwner(['thread', '--since', 'garbage'], options)).toBe(2);
    } finally { console.log = write; }
    const byChannel = JSON.parse(lines[0] ?? '{}') as { messages: Array<{ channel: string }> };
    const bySince = JSON.parse(lines[1] ?? '{}') as { messages: Array<{ seq: number }> };
    expect(byChannel.messages.map(message => message.channel)).toEqual(['email']);
    expect(bySince.messages.map(message => message.seq)).toEqual([2]);
  });

  it('keeps an unreadable thread unavailable under a filter', () => {
    const { options } = fixture();
    mkdirSync(join(options.runsDir, 'leader'), { recursive: true });
    writeFileSync(join(options.runsDir, 'leader', 'owner-thread.json'), 'not json', { mode: 0o600 });
    const view = readOwnerThread(options, 200, { channel: 'telegram', since: 1 });
    expect('unavailable' in view).toBe(true);
    expect(view.awaitingReply).toBeNull();
  });

  it('filters the thread read by contains text, keeping marks inside the slice', async () => {
    const { options } = fixture();
    await acceptOwnerInbound({ channel: 'telegram', senderId: 'telegram:100', text: 'Deploy the API\nplease', idempotencyKey: 'telegram-msg-1', at: 1_700_000_000_000 }, options);
    await acceptOwnerInbound({ channel: 'email', senderId: 'email:owner@example.com', text: 'deploy window moved', idempotencyKey: 'email-msg-0001', at: 1_700_000_100_000 }, options);
    await acceptOwnerInbound({ channel: 'slack', senderId: 'U0123456789', text: 'lunch?', idempotencyKey: 'slack-msg-0003', at: 1_700_000_200_000 }, options);
    await sendOwnerReply({ text: 'deploy answer', replyTo: 'telegram-msg-1', idempotencyKey: 'reply-owner-01' }, options);
    // m1 telegram inbound, m2 email inbound, m3 slack inbound, m4 outbound reply on telegram.
    const hits = readOwnerThread(options, 200, { contains: 'DEPLOY' });
    expect(hits.messages.map(message => message.seq)).toEqual([1, 2, 4]);
    // m1 is answered by m4; m2 still waits and m3 is hidden — the mark follows the same slice.
    expect(hits.awaitingReply).toEqual(['m2']);
    const outbound = hits.messages.find(message => message.direction === 'outbound')!;
    expect(Object.keys(hits.receipts[outbound.id] ?? {}).sort()).toEqual(['desktop', 'telegram']);
    // Whitespace collapses on both sides: a phrase broken by the newline still matches.
    expect(readOwnerThread(options, 200, { contains: 'api  please' }).messages.map(message => message.seq)).toEqual([1]);
    // A needle nothing carries is an honest empty slice, and the filter composes with channel.
    expect(readOwnerThread(options, 200, { contains: 'no-such-text' }).messages).toEqual([]);
    const emailOnly = readOwnerThread(options, 200, { channel: 'email', contains: 'deploy' });
    expect(emailOnly.messages.map(message => message.seq)).toEqual([2]);
    expect(emailOnly.awaitingReply).toEqual(['m2']);
  });

  it('serves contains on the thread CLI and rejects bad needles', async () => {
    const { options } = fixture();
    await acceptOwnerInbound({ channel: 'telegram', senderId: 'telegram:100', text: 'first deploy', idempotencyKey: 'telegram-msg-1', at: 1_700_000_000_000 }, options);
    await acceptOwnerInbound({ channel: 'email', senderId: 'email:owner@example.com', text: 'second ping', idempotencyKey: 'email-msg-0001', at: 1_700_000_100_000 }, options);
    const lines: string[] = [];
    const write = console.log;
    console.log = (line?: unknown) => { lines.push(String(line)); };
    try {
      expect(await cmdCommsOwner(['thread', '--contains', 'DEPLOY', '--json'], options)).toBe(0);
      expect(await cmdCommsOwner(['thread', '--contains', ''], options)).toBe(2);
      expect(await cmdCommsOwner(['thread', '--contains'], options)).toBe(2);
      expect(await cmdCommsOwner(['thread', '--contains', 'x'.repeat(513)], options)).toBe(2);
      expect(await cmdCommsOwner(['thread', '--contains', '--json'], options)).toBe(2);
    } finally { console.log = write; }
    const view = JSON.parse(lines[0] ?? '{}') as { messages: Array<{ text: string }> };
    expect(view.messages.map(message => message.text)).toEqual(['first deploy']);
  });

  it('filters the thread read by replyTo, keeping the whole exchange across channels', async () => {
    const { options } = fixture();
    await acceptOwnerInbound({ channel: 'telegram', senderId: 'telegram:100', text: 'deploy question', idempotencyKey: 'telegram-msg-1', at: 1_700_000_000_000 }, options);
    await acceptOwnerInbound({ channel: 'email', senderId: 'email:owner@example.com', text: 'unrelated ping', idempotencyKey: 'email-msg-0001', at: 1_700_000_100_000 }, options);
    await sendOwnerReply({ text: 'deploy answer', replyTo: 'telegram-msg-1', idempotencyKey: 'reply-owner-01' }, options);
    await sendOwnerReply({ text: 'second deploy answer', replyTo: 'telegram-msg-1', idempotencyKey: 'reply-owner-02' }, options);
    // m1 telegram inbound, m2 email inbound, m3+m4 outbound replies citing m1's key across the fanout.
    const exchange = readOwnerThread(options, 200, { replyTo: 'telegram-msg-1' });
    expect(exchange.messages.map(message => message.seq)).toEqual([1, 3, 4]);
    expect(exchange.awaitingReply).toEqual([]);
    // The email inbound is answered by nothing and stays out of the slice.
    expect(exchange.messages.some(message => message.channel === 'email')).toBe(false);
    // An unanswered inbound's exchange is just itself, still marked awaiting.
    const pending = readOwnerThread(options, 200, { replyTo: 'email-msg-0001' });
    expect(pending.messages.map(message => message.seq)).toEqual([2]);
    expect(pending.awaitingReply).toEqual(['m2']);
    // An outbound key matches only the message carrying it — no replyTo ever cites one.
    const own = readOwnerThread(options, 200, { replyTo: 'reply-owner-01' });
    expect(own.messages.map(message => message.seq)).toEqual([3]);
    // A key nothing carries is an honest empty slice, and the filter composes with direction.
    expect(readOwnerThread(options, 200, { replyTo: 'no-such-key-1' }).messages).toEqual([]);
    const outboundOnly = readOwnerThread(options, 200, { replyTo: 'telegram-msg-1', direction: 'outbound' });
    expect(outboundOnly.messages.map(message => message.seq)).toEqual([3, 4]);
    expect(outboundOnly.awaitingReply).toEqual([]);
  });

  it('serves reply-to on the thread CLI and rejects bad keys', async () => {
    const { options } = fixture();
    await acceptOwnerInbound({ channel: 'telegram', senderId: 'telegram:100', text: 'tg', idempotencyKey: 'telegram-msg-1', at: 1_700_000_000_000 }, options);
    await acceptOwnerInbound({ channel: 'email', senderId: 'email:owner@example.com', text: 'em', idempotencyKey: 'email-msg-0001', at: 1_700_000_100_000 }, options);
    await sendOwnerReply({ text: 'answer', replyTo: 'telegram-msg-1', idempotencyKey: 'reply-owner-01' }, options);
    const lines: string[] = [];
    const write = console.log;
    console.log = (line?: unknown) => { lines.push(String(line)); };
    try {
      expect(await cmdCommsOwner(['thread', '--reply-to', 'telegram-msg-1', '--json'], options)).toBe(0);
      expect(await cmdCommsOwner(['thread', '--reply-to', 'email-msg-0001', '--json'], options)).toBe(0);
      expect(await cmdCommsOwner(['thread', '--reply-to', 'has space'], options)).toBe(2);
      expect(await cmdCommsOwner(['thread', '--reply-to', 'short'], options)).toBe(2);
      expect(await cmdCommsOwner(['thread', '--reply-to'], options)).toBe(2);
      expect(await cmdCommsOwner(['thread', '--reply-to', '--json'], options)).toBe(2);
    } finally { console.log = write; }
    const exchange = JSON.parse(lines[0] ?? '{}') as { messages: Array<{ seq: number; direction: string }> };
    const pending = JSON.parse(lines[1] ?? '{}') as { messages: Array<{ seq: number }> };
    expect(exchange.messages.map(message => [message.seq, message.direction])).toEqual([[1, 'inbound'], [3, 'outbound']]);
    expect(pending.messages.map(message => message.seq)).toEqual([2]);
  });

  it('filters the thread read by direction, keeping marks inside the slice', async () => {
    const { options } = fixture();
    await acceptOwnerInbound({ channel: 'telegram', senderId: 'telegram:100', text: 'tg question', idempotencyKey: 'telegram-msg-1', at: 1_700_000_000_000 }, options);
    await acceptOwnerInbound({ channel: 'email', senderId: 'email:owner@example.com', text: 'em ping', idempotencyKey: 'email-msg-0001', at: 1_700_000_100_000 }, options);
    await sendOwnerReply({ text: 'answer', replyTo: 'telegram-msg-1', idempotencyKey: 'reply-owner-01' }, options);
    // m1 telegram inbound, m2 email inbound, m3 outbound reply on telegram at the fixture clock.
    const inbound = readOwnerThread(options, 200, { direction: 'inbound' });
    expect(inbound.messages.map(message => [message.seq, message.direction])).toEqual([[1, 'inbound'], [2, 'inbound']]);
    expect(inbound.awaitingReply).toEqual(['m2']);
    expect(inbound.receipts).toEqual({});
    const outbound = readOwnerThread(options, 200, { direction: 'outbound' });
    expect(outbound.messages.map(message => [message.seq, message.direction])).toEqual([[3, 'outbound']]);
    // The awaiting-reply mark only ever applies to inbound rows, so an outbound slice reports none.
    expect(outbound.awaitingReply).toEqual([]);
    expect(Object.keys(outbound.receipts)).toEqual(['m3']);
    // Direction composes with the other slices.
    const emailOutbound = readOwnerThread(options, 200, { channel: 'email', direction: 'outbound' });
    expect(emailOutbound.messages).toEqual([]);
    expect(emailOutbound.awaitingReply).toEqual([]);
    const telegramInbound = readOwnerThread(options, 200, { channel: 'telegram', direction: 'inbound' });
    expect(telegramInbound.messages.map(message => message.seq)).toEqual([1]);
    expect(telegramInbound.awaitingReply).toEqual([]);
  });

  it('serves direction on the thread CLI and rejects bad values', async () => {
    const { options } = fixture();
    await acceptOwnerInbound({ channel: 'telegram', senderId: 'telegram:100', text: 'tg', idempotencyKey: 'telegram-msg-1', at: 1_700_000_000_000 }, options);
    await sendOwnerReply({ text: 'answer', idempotencyKey: 'reply-owner-01' }, options);
    const lines: string[] = [];
    const write = console.log;
    console.log = (line?: unknown) => { lines.push(String(line)); };
    try {
      expect(await cmdCommsOwner(['thread', '--direction', 'inbound', '--json'], options)).toBe(0);
      expect(await cmdCommsOwner(['thread', '--direction', 'outbound', '--json'], options)).toBe(0);
      expect(await cmdCommsOwner(['thread', '--direction', 'bogus'], options)).toBe(2);
      expect(await cmdCommsOwner(['thread', '--direction'], options)).toBe(2);
      expect(await cmdCommsOwner(['thread', '--direction', '--json'], options)).toBe(2);
    } finally { console.log = write; }
    const inbound = JSON.parse(lines[0] ?? '{}') as { messages: Array<{ direction: string }> };
    const outbound = JSON.parse(lines[1] ?? '{}') as { messages: Array<{ direction: string }> };
    expect(inbound.messages.map(message => message.direction)).toEqual(['inbound']);
    expect(outbound.messages.map(message => message.direction)).toEqual(['outbound']);
  });

  it('filters the thread read by awaiting, keeping only unanswered inbound in the slice', async () => {
    const { options } = fixture();
    await acceptOwnerInbound({ channel: 'telegram', senderId: 'telegram:100', text: 'tg question', idempotencyKey: 'telegram-msg-1', at: 1_700_000_000_000 }, options);
    await acceptOwnerInbound({ channel: 'email', senderId: 'email:owner@example.com', text: 'em ping', idempotencyKey: 'email-msg-0001', at: 1_700_000_100_000 }, options);
    await sendOwnerReply({ text: 'answer', replyTo: 'telegram-msg-1', idempotencyKey: 'reply-owner-01' }, options);
    await acceptOwnerInbound({ channel: 'desktop', senderId: 'local-owner', text: 'desk note', idempotencyKey: 'desktop-msg-001', at: 1_700_000_200_000 }, options);
    // m1 telegram inbound answered, m2 email inbound awaiting, m3 outbound reply, m4 desktop inbound awaiting.
    const awaiting = readOwnerThread(options, 200, { awaiting: true });
    expect(awaiting.messages.map(message => message.seq)).toEqual([2, 4]);
    expect(awaiting.awaitingReply).toEqual(['m2', 'm4']);
    // Awaiting composes with the other slices and is inherently inbound-only.
    const emailAwaiting = readOwnerThread(options, 200, { awaiting: true, channel: 'email' });
    expect(emailAwaiting.messages.map(message => message.seq)).toEqual([2]);
    expect(readOwnerThread(options, 200, { awaiting: true, direction: 'outbound' }).messages).toEqual([]);
    expect(readOwnerThread(options, 200, { awaiting: true, contains: 'ping' }).messages.map(message => message.seq)).toEqual([2]);
    expect(readOwnerThread(options, 200, { awaiting: true, contains: 'answer' }).messages).toEqual([]);
  });

  it('serves awaiting on the thread CLI', async () => {
    const { options } = fixture();
    await acceptOwnerInbound({ channel: 'telegram', senderId: 'telegram:100', text: 'tg question', idempotencyKey: 'telegram-msg-1', at: 1_700_000_000_000 }, options);
    await sendOwnerReply({ text: 'answer', idempotencyKey: 'reply-owner-01' }, options);
    await acceptOwnerInbound({ channel: 'email', senderId: 'email:owner@example.com', text: 'em ping', idempotencyKey: 'email-msg-0001', at: 1_700_000_100_000 }, options);
    const lines: string[] = [];
    const write = console.log;
    console.log = (line?: unknown) => { lines.push(String(line)); };
    try {
      expect(await cmdCommsOwner(['thread', '--awaiting', '--json'], options)).toBe(0);
    } finally { console.log = write; }
    const view = JSON.parse(lines[0] ?? '{}') as { messages: Array<{ seq: number; direction: string }>; awaitingReply: string[] };
    expect(view.messages.map(message => [message.seq, message.direction])).toEqual([[3, 'inbound']]);
    expect(view.awaitingReply).toEqual(['m3']);
  });
});

function writeForgedHome(root: string, email: string, slackId: string, handle: string): void {
  const config = join(root, '.ashlr');
  const runs = join(root, '.ashlr-runs');
  mkdirSync(config, { mode: 0o700 });
  mkdirSync(join(config, 'comms'), { mode: 0o700 });
  mkdirSync(runs, { mode: 0o700 });
  mkdirSync(join(runs, 'queue'), { mode: 0o700 });
  mkdirSync(join(runs, 'in'), { mode: 0o700 });
  writeFileSync(join(config, 'agent-network.toml'), `[mason]\nidentities = [{ channel = "email", id = "email:${email}" }, { channel = "slack", id = "${slackId}" }, { channel = "imessage", id = "${handle}" }]\n[team]\nidentities = [{ channel = "email", id = "email:${email}" }, { channel = "slack", id = "${slackId}" }, { channel = "imessage", id = "${handle}" }]\n[slack]\nsecretHandle = "phm_SLACK_BOT_TOKEN"\n`, { mode: 0o600 });
  writeFileSync(join(config, 'comms.toml'), 'confirmedByMason = true\n', { mode: 0o600 });
  writeFileSync(join(config, 'comms', 'owner-adapters.toml'), '[email]\nsecretHandle = "phm_EMAIL_CREDENTIAL"\n[slack]\nsecretHandle = "phm_SLACK_BOT_TOKEN"\n[imessage]\nbridge = "loopback"\n', { mode: 0o600 });
  writeFileSync(join(config, 'config.json'), `${JSON.stringify({ comms: { enabled: true, imessageHandle: handle, channel: 'imessage' } })}\n`, { mode: 0o600 });
  writeFileSync(join(runs, 'queue', 'email-drop.json'), `${JSON.stringify({ v: 1, enabled: true, sendReplies: true, inboxDir: join(runs, 'in'), from: [email] })}\n`, { mode: 0o600 });
}

function slackProbe(channel: Record<string, unknown>, members: string[]): { call: (method: string) => Promise<Record<string, unknown>>; methods: string[] } {
  const methods: string[] = [];
  return { methods, call: async method => {
    methods.push(method);
    if (method === 'conversations.info') return { channel };
    if (method === 'conversations.members') return { members };
    if (method === 'auth.test') return { user_id: 'U0BOTUSER1', bot_id: 'B0BOTUSER1' };
    return {};
  } };
}
