/**
 * RQ-PHX-TELEGRAMTOINBOX31 — Telegram → MASON-INBOX.md bridge.
 *
 * Module under test: src/core/comms/telegram-inbox-bridge.ts.
 *
 * A verified Mason text event is receipted into <runsDir>/leader/MASON-INBOX.md
 * through the shared channel receiver — channel `telegram`, sender
 * `telegram:<userId>` — and acknowledged back on Telegram as a reply carrying
 * formatChannelAck() plus an `Inbox:` preview line. Unverified events write
 * nothing and get no reply; a rejecting Telegram send never unwrites an
 * accepted entry.
 *
 * No network: `send` is an injected fake; HOME and runsDir are tmp dirs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordTelegramToInbox, telegramChannelMessage } from '../src/core/comms/telegram-inbox-bridge.js';
import { formatChannelAck } from '../src/core/fleet/channel-ack-text.js';
import type { InboundEvent, TelegramSendOpts, TelegramSendResult } from '../src/core/integrations/telegram.js';
import type { AshlrConfig } from '../src/core/types.js';

const OWNER = 1234567;
const CHAT = String(OWNER);

function cfg(): AshlrConfig {
  return { comms: { enabled: true, channel: 'telegram', telegram: { botToken: 'fake-token-bridge-31', chatId: CHAT } } } as AshlrConfig;
}

function textEvent(over: Partial<InboundEvent> = {}): InboundEvent {
  return {
    updateId: 1, kind: 'text', text: 'focus the fleet on billing', fromChatId: CHAT,
    senderUserId: OWNER, privateChat: true, messageId: 55, ...over,
  };
}

type FakeSend = ReturnType<typeof vi.fn<(text: string, opts?: TelegramSendOpts, cfg?: AshlrConfig) => Promise<TelegramSendResult>>>;

let home = '';
let runsDir = '';
let previousHome: string | undefined;
let send: FakeSend;

const inboxPath = () => join(runsDir, 'leader', 'MASON-INBOX.md');
const inboxText = () => readFileSync(inboxPath(), 'utf8');

beforeEach(() => {
  previousHome = process.env['HOME'];
  home = mkdtempSync(join(tmpdir(), 'tg-bridge-home-'));
  runsDir = mkdtempSync(join(tmpdir(), 'tg-bridge-runs-'));
  process.env['HOME'] = home;
  send = vi.fn(async (): Promise<TelegramSendResult> => ({ ok: true, messageId: 9000 }));
});

afterEach(() => {
  if (previousHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = previousHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(runsDir, { recursive: true, force: true });
});

describe('telegramChannelMessage (pure, fail closed)', () => {
  it('maps a verified private text event to a canonical telegram message', () => {
    expect(telegramChannelMessage(textEvent(), 'hello fleet')).toEqual({
      channel: 'telegram', verifiedSenderId: `telegram:${OWNER}`, body: 'hello fleet',
    });
  });

  it.each([
    { name: 'missing senderUserId', over: { senderUserId: undefined } },
    { name: 'zero senderUserId', over: { senderUserId: 0 } },
    { name: 'negative senderUserId', over: { senderUserId: -5 } },
    { name: 'fractional senderUserId', over: { senderUserId: 1.5 } },
    { name: 'group chat flag', over: { privateChat: false } },
    { name: 'missing privateChat', over: { privateChat: undefined } },
    { name: 'callback kind', over: { kind: 'callback' as const } },
  ])('returns null for $name', ({ over }) => {
    expect(telegramChannelMessage(textEvent(over), 'hello fleet')).toBeNull();
  });
});

describe('recordTelegramToInbox', () => {
  it('accepted: one inbox entry attributed to telegram + one reply ack', async () => {
    const config = cfg();
    const result = await recordTelegramToInbox(textEvent(), 'focus the fleet on billing', config, { send, runsDir });
    expect(result).toMatchObject({ ok: true, ack: { channel: 'telegram', status: 'accepted' } });
    expect(result.ok && result.envelope.verifiedSenderId).toBe(`telegram:${OWNER}`);

    const inbox = inboxText();
    expect(inbox.match(/^## /gm)).toHaveLength(1);
    expect(inbox).toContain('(Mason, telegram)');
    expect(inbox).toContain('focus the fleet on billing');

    expect(send).toHaveBeenCalledTimes(1);
    const [body, opts, passedCfg] = send.mock.calls[0]!;
    expect(opts).toEqual({ replyToMessageId: 55 });
    expect(passedCfg).toBe(config);
    // Whatever formatChannelAck emits for `accepted`, the reply carries it verbatim.
    expect(body).toContain(result.ok ? formatChannelAck(result.ack) : 'unreachable');
    expect(body).toContain('Inbox: focus the fleet on billing');
  });

  it('duplicate within the window: no new entry, one reply saying duplicate', async () => {
    const first = await recordTelegramToInbox(textEvent({ messageId: 55 }), 'same words twice', cfg(), { send, runsDir });
    const second = await recordTelegramToInbox(textEvent({ messageId: 56 }), 'same words twice', cfg(), { send, runsDir });
    expect(first.ok && first.ack.status).toBe('accepted');
    expect(second).toMatchObject({ ok: true, ack: { status: 'duplicate' } });
    expect(second.ok && second.ack.dedupeKey).toBe(first.ok && first.envelope.dedupeKey);

    expect(inboxText().match(/^## /gm)).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0]).toContain('duplicate');
    expect(send.mock.calls[1]![0]).toContain(second.ok ? formatChannelAck(second.ack) : 'unreachable');
    expect(send.mock.calls[1]![1]).toEqual({ replyToMessageId: 56 });
  });

  it.each([
    { name: 'missing senderUserId', over: { senderUserId: undefined } },
    { name: 'not a private chat', over: { privateChat: false } },
    { name: 'foreign sender id', over: { senderUserId: 7654321 } },
  ])('unverified/foreign event ($name): no write, no send, sender-not-allowed', async ({ over }) => {
    const result = await recordTelegramToInbox(textEvent(over), 'focus the fleet on billing', cfg(), { send, runsDir });
    expect(result).toEqual({ ok: false, reason: 'sender-not-allowed' });
    expect(existsSync(inboxPath())).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('receiver failure: reports the reason in one reply, writes nothing', async () => {
    // A regular file where runsDir must be a directory makes every store op fail.
    const broken = join(runsDir, 'blocked');
    writeFileSync(broken, 'not a dir');
    const result = await recordTelegramToInbox(textEvent(), 'focus the fleet on billing', cfg(), { send, runsDir: join(broken, 'sub') });
    expect(result.ok).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatch(/^Not recorded: \S+/);
    expect(existsSync(inboxPath())).toBe(false);
  });

  it('ack send rejecting: entry still written, resolves ok:true', async () => {
    send.mockRejectedValue(new Error('fake telegram outage'));
    const result = await recordTelegramToInbox(textEvent(), 'focus the fleet on billing', cfg(), { send, runsDir });
    expect(result).toMatchObject({ ok: true, ack: { status: 'accepted' } });
    expect(send).toHaveBeenCalledTimes(1);
    const inbox = inboxText();
    expect(inbox).toContain('(Mason, telegram)');
    expect(inbox).toContain('focus the fleet on billing');
  });
});
