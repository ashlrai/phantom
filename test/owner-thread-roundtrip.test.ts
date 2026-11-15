/** One owner message through the real receipt path: channel -> owner thread (+ leader inbox) -> reply
 * back on the same channel and desktop only. Everything lives in mkdtemp dirs passed through options. */
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChannelEnvelope } from '../src/core/fleet/channel-envelope.js';
import { composeLeaderInbox, receiptLeaderChannel, type LeaderRuntimeOptions } from '../src/core/agents/leader-network-runtime.js';
import { loadOwnerThreadSettings, type OwnerChannelTransport, type OwnerDelivery } from '../src/core/comms/owner-channel.js';
import { readOwnerThread, sendOwnerReply, type OwnerThreadOptions } from '../src/core/comms/owner-thread.js';

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

const HANDLE = '+15550100';
const TELEGRAM = 'telegram:1000001';
const NOW = Date.now();

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'owner-roundtrip-'));
  roots.push(root);
  const configDir = join(root, 'config');
  mkdirSync(join(configDir, 'comms'), { recursive: true, mode: 0o700 });
  const identities = `[{ channel = "bus", id = "local-owner" }, { channel = "imessage", id = "${HANDLE}" }, { channel = "telegram", id = "${TELEGRAM}" }]`;
  writeFileSync(join(configDir, 'agent-network.toml'),
    `[mason]\nidentities = ${identities}\n[team]\nidentities = [{ channel = "bus", id = "leader" }, ${identities.slice(1)}\n`, { mode: 0o600 });
  writeFileSync(join(configDir, 'comms.toml'), 'confirmedByMason = true\n', { mode: 0o600 });
  writeFileSync(join(configDir, 'comms', 'owner-adapters.toml'),
    '[telegram]\nsecretHandle = "phm_TELEGRAM_BOT_TOKEN"\n[imessage]\nbridge = "loopback"\n', { mode: 0o600 });
  const runsDir = join(root, 'runs');
  const busRoot = join(root, 'bus');
  const runtime: LeaderRuntimeOptions = { runsDir, busRoot, configDir, now: () => NOW };
  const thread: OwnerThreadOptions = { runsDir, busRoot, now: () => NOW, settings: loadOwnerThreadSettings(configDir), halted: false, paused: false };
  return { root, runtime, thread };
}

function envelope(channel: 'imessage' | 'telegram', verifiedSenderId: string, dedupeKey: string, extra: Partial<ChannelEnvelope> = {}): ChannelEnvelope {
  return { channel, verifiedSenderId, body: 'Synthetic hello', receivedAt: new Date(NOW).toISOString(), dedupeKey, ...extra };
}

function spyTransports(names: string[]) {
  const calls: Array<{ name: string; input: OwnerDelivery }> = [];
  const transports: Record<string, OwnerChannelTransport> = {};
  for (const name of names) {
    transports[name] = { async pull() { return []; }, async deliver(input) { calls.push({ name, input }); return { status: 'sent', reason: 'ok' }; } };
  }
  return { calls, transports: transports as OwnerThreadOptions['transports'] };
}

function filesUnder(dir: string): string[] {
  try {
    return readdirSync(dir).flatMap(name => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? filesUnder(path) : [path];
    });
  } catch { return []; }
}

describe('owner thread round trip', () => {
  it('lands an iMessage once, dedupes a redelivery, and keeps the text off the bus', async () => {
    const { runtime, thread } = setup();
    const inbound = envelope('imessage', HANDLE, 'imessage-dedupe-0001');
    expect(await receiptLeaderChannel(inbound, runtime)).toBe('ignored');
    await receiptLeaderChannel(inbound, runtime);
    const lines = readOwnerThread(thread).messages;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ direction: 'inbound', channel: 'imessage', senderId: HANDLE, text: 'Synthetic hello' });
    for (const file of filesUnder(runtime.busRoot!)) expect(readFileSync(file, 'utf8')).not.toContain('Synthetic hello');
  });

  it('lands a Telegram message in the owner thread and the leader inbox', async () => {
    const { runtime, thread } = setup();
    expect(await receiptLeaderChannel(envelope('telegram', TELEGRAM, 'telegram-dedupe-0001', { threadId: '42' }), runtime)).toBe('published');
    expect(readOwnerThread(thread).messages.map(line => [line.direction, line.channel])).toEqual([['inbound', 'telegram']]);
    // The channel receiver owns MASON-INBOX.md (inboxAlreadyRecorded), so the leader's receipt is its network state.
    const state = readFileSync(join(runtime.runsDir!, 'leader', 'network-state.json'), 'utf8');
    expect(state).toContain('"id":"mason-telegram-telegram-dedupe-"');
    expect(state).toContain('"text":"Synthetic hello"');
  });

  it('replies on the channel the owner used and to desktop, and to nobody else', async () => {
    const { runtime, thread } = setup();
    await receiptLeaderChannel(envelope('imessage', HANDLE, 'imessage-reply-0001'), runtime);
    const spy = spyTransports(['imessage', 'telegram', 'email', 'slack']);
    const result = await sendOwnerReply({ text: 'Synthetic answer' }, { ...thread, transports: spy.transports });
    expect(spy.calls.map(call => [call.name, call.input.ownerId, call.input.text])).toEqual([['imessage', HANDLE, 'Synthetic answer']]);
    expect(result.deliveries?.map(row => row.channel)).toEqual(['imessage', 'desktop']);
    const outbound = readOwnerThread(thread).messages.filter(line => line.direction === 'outbound');
    expect(outbound).toHaveLength(1);
    expect(outbound[0]?.fanout).toEqual(['imessage', 'desktop']);
  });

  it('records nothing and calls no transport for an unknown sender', async () => {
    const { runtime, thread } = setup();
    await receiptLeaderChannel(envelope('imessage', '+15550199', 'imessage-stranger-01'), runtime);
    await receiptLeaderChannel(envelope('telegram', 'telegram:2000002', 'telegram-stranger-01'), runtime);
    expect(readOwnerThread(thread).messages).toEqual([]);
    const spy = spyTransports(['imessage', 'telegram', 'desktop']);
    expect((await sendOwnerReply({ text: 'Synthetic answer' }, { ...thread, transports: spy.transports })).status).toBe('refused');
    expect(spy.calls).toEqual([]);
  });

  it('refuses a reply before any transport call while KILL is armed', async () => {
    const { root, runtime, thread } = setup();
    await receiptLeaderChannel(envelope('imessage', HANDLE, 'imessage-kill-00001'), runtime);
    // KILL is read from the process home, which the vitest setup relocates; point it at a temp dir.
    const home = join(root, 'home');
    mkdirSync(join(home, '.ashlr'), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, '.ashlr', 'KILL'), 'kill switch active\n', { mode: 0o600 });
    vi.stubEnv('HOME', home);
    const spy = spyTransports(['imessage', 'desktop']);
    expect((await sendOwnerReply({ text: 'Synthetic answer' }, { ...thread, transports: spy.transports })).status).toBe('halted');
    expect(spy.calls).toEqual([]);
  });

  it('records one desktop inbound line for a confirmed desktop compose', async () => {
    const { runtime, thread } = setup();
    expect((await composeLeaderInbox('Synthetic hello', runtime)).ok).toBe(true);
    expect(readOwnerThread(thread).messages.map(line => [line.direction, line.channel, line.senderId, line.text]))
      .toEqual([['inbound', 'desktop', 'local-owner', 'Synthetic hello']]);
  });
});
