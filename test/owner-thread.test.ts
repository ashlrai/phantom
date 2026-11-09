import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cmdCommsOwner, cmdCommsOwnerStatus } from '../src/cli/comms-owner-thread.js';
import { createLeaderMailbox } from '../src/core/comms/leader-mailbox.js';
import { loadOwnerThreadSettings, type OwnerChannelTransport, type OwnerDelivery, type OwnerThreadSettings } from '../src/core/comms/owner-channel.js';
import { acceptOwnerInbound, pullOwnerChannel, readOwnerThread, sendOwnerReply, type OwnerThreadOptions } from '../src/core/comms/owner-thread.js';
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
    const planted = '123456:AAFxxxxxxxxxxxxxxxxxxxxxxxxxxx';
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
});
