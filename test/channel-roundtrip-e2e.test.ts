/**
 * RQ-PHX-CHANNELROUNDTRIPE2E03 — one instruction, two surfaces, one round trip.
 *
 * Mason's Oct 31 00:13 order (channel-agnostic input with dedupe, source
 * attribution and same-channel ack) plus Nov 1 00:08 (input and status on
 * every surface), proven end-to-end through the real adapters:
 *
 *   telegram → recordTelegramToInbox ─┐
 *                                     ├→ createChannelReceiver → MASON-INBOX.md
 *   .eml drop → recordEmailToInbox ──┘        → agent-bus mirror
 *                                             → same-channel ack each time
 *
 * A verified Telegram text and a drop-folder email carrying the SAME order
 * text inside the dedupe window must land as ONE inbox entry: `[src:telegram
 * id:…] [also:email]` — attributed to the first source, the second recorded
 * as a duplicate merge, not a second entry. The accepted receipt mirrors one
 * interjection envelope onto the durable bus; each surface's own transport
 * (a Telegram reply, a reply `.eml` in the outbox) carries exactly one ack;
 * re-delivering both inputs is idempotent.
 *
 * Hermetic: HOME and ASHLR_HOME are fresh tmp dirs (the runs dir, receipt
 * store, pairing file and bus root all resolve under them), the Telegram send
 * is an injected fake, the email outbox is a tmp dir, the clocks are fixed
 * fakes, all ids/addresses are fake, and nothing touches the network or the
 * real ~/.ashlr-runs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordTelegramToInbox } from '../src/core/comms/telegram-inbox-bridge.js';
import { recordEmailToInbox } from '../src/core/comms/email-drop-bridge.js';
import { formatChannelAck } from '../src/core/fleet/channel-ack-text.js';
import { parseInbox } from '../src/core/fleet/mason-inbox.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { rememberEmailPair } from '../src/core/fleet/operator-glance-read.js';
import type { InboundEvent, TelegramSendOpts, TelegramSendResult } from '../src/core/integrations/telegram.js';
import type { AshlrConfig } from '../src/core/types.js';

const ORDER = 'focus the fleet on billing';
const TG_OWNER = 7654321; // obviously fake chat/user id
const TG_CHAT = String(TG_OWNER);
const MASON_MAIL = 'mason@example.com';
const MAIL_ID = '<roundtrip-1@mail.example.com>';
const T0 = Date.parse('2026-11-01T00:30:00.000Z');
const T1 = T0 + 30_000; // inside the 10-minute cross-channel window

function cfg(): AshlrConfig {
  return { comms: { enabled: true, channel: 'telegram', telegram: { botToken: 'fake-token-roundtrip-e2e', chatId: TG_CHAT } } } as AshlrConfig;
}

function textEvent(over: Partial<InboundEvent> = {}): InboundEvent {
  return {
    updateId: 1, kind: 'text', text: ORDER, fromChatId: TG_CHAT,
    senderUserId: TG_OWNER, privateChat: true, messageId: 42, ...over,
  };
}

function eml(over: { id?: string } = {}): string {
  return [
    `From: Mason Wyatt <${MASON_MAIL}>`,
    'To: phantom@example.com',
    `Message-ID: ${over.id ?? MAIL_ID}`,
    'Date: Sat, 01 Nov 2026 00:30:20 +0000',
    'Authentication-Results: mx.example.com; dkim=pass header.d=example.com',
    '',
    ORDER,
    '',
  ].join('\r\n');
}

let home = '';
let ashlrHome = '';
let outboxDir = '';
let previousHome: string | undefined;
let previousAshlrHome: string | undefined;
let previousSecret: string | undefined;
const roots: string[] = [];

const dir = (prefix: string): string => {
  const path = mkdtempSync(join(tmpdir(), prefix));
  roots.push(path);
  return path;
};

type FakeSend = ReturnType<typeof vi.fn<(text: string, opts?: TelegramSendOpts, cfg?: AshlrConfig) => Promise<TelegramSendResult>>>;
let send: FakeSend;

const runsDir = () => join(home, '.ashlr-runs');
const inboxPath = () => join(runsDir(), 'leader', 'MASON-INBOX.md');
const inboxText = () => readFileSync(inboxPath(), 'utf8');
const replyFiles = () => readdirSync(outboxDir).filter((name) => name.endsWith('.reply.eml')).sort();

const telegramOrder = () => recordTelegramToInbox(textEvent(), ORDER, cfg(), { send, now: () => new Date(T0) });
const emailOrder = () => recordEmailToInbox(eml(), { allowedSenders: new Set([MASON_MAIL]), outboxDir, now: () => new Date(T1) });

beforeEach(() => {
  previousHome = process.env['HOME'];
  previousAshlrHome = process.env['ASHLR_HOME'];
  previousSecret = process.env['PHANTOM_OPERATOR_SECRET'];
  home = dir('rt-home-');
  ashlrHome = dir('rt-ashlr-');
  outboxDir = dir('rt-outbox-');
  process.env['HOME'] = home;
  process.env['ASHLR_HOME'] = ashlrHome;
  delete process.env['PHANTOM_OPERATOR_SECRET'];
  // Without an operator secret the email gate needs a prior pairing + DKIM pass.
  rememberEmailPair(MASON_MAIL, runsDir());
  send = vi.fn(async (): Promise<TelegramSendResult> => ({ ok: true, messageId: 9000 }));
});

afterEach(() => {
  if (previousHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = previousHome;
  if (previousAshlrHome === undefined) delete process.env['ASHLR_HOME'];
  else process.env['ASHLR_HOME'] = previousAshlrHome;
  if (previousSecret === undefined) delete process.env['PHANTOM_OPERATOR_SECRET'];
  else process.env['PHANTOM_OPERATOR_SECRET'] = previousSecret;
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

describe('channel round trip: telegram + email carrying one instruction', () => {
  it('one inbox entry attributed to the first source, the second merged as duplicate', async () => {
    const first = await telegramOrder();
    const second = await emailOrder();

    // a) exactly one entry: first source attributed, second recorded as a duplicate merge.
    expect(first).toMatchObject({ ok: true, ack: { channel: 'telegram', status: 'accepted' } });
    expect(second).toMatchObject({ ok: true, ack: { channel: 'email', status: 'duplicate' } });
    expect(second.ok && second.ack.dedupeKey).toBe(first.ok && first.envelope.dedupeKey);
    expect(second.ok && second.ack.entryId).toMatch(/^telegram-[0-9a-f]{16}$/);

    const markdown = inboxText();
    expect(markdown.match(/\[src:/g)).toHaveLength(1);
    expect(markdown).toMatch(/^\d{4}-\d{2}-\d{2}T\S+ \[src:telegram id:telegram-[0-9a-f]{16}\] \[also:email\] focus the fleet on billing$/m);
    const entries = parseInbox(markdown);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ channel: 'telegram', alsoChannels: ['email'], text: ORDER });
    expect(markdown).not.toContain(String(TG_OWNER));
    expect(markdown).not.toContain(MASON_MAIL);

    // b) a bus event exists for the entry — one interjection mirror, not two.
    const page = listBusInboxAfter(0, 50);
    expect(page.status).toBe('ok');
    const interjections = page.status === 'ok'
      ? page.messages.filter((row) => (row.envelope.body as { kind?: string }).kind === 'interjection')
      : [];
    expect(interjections).toHaveLength(1);
    expect(interjections[0]!.envelope.id).toBe(`mason-telegram-${(first.ok ? first.envelope.dedupeKey : '').slice(0, 16)}`);
    expect(interjections[0]!.envelope.body).toMatchObject({
      kind: 'interjection', channel: 'telegram', text: ORDER,
      dedupeKey: first.ok ? first.envelope.dedupeKey : 'unreachable',
    });
    expect(first.ok && first.publishState).toBe('published');

    // c) one ack on each source's own channel, none anywhere else.
    expect(send).toHaveBeenCalledTimes(1);
    const [replyText, replyOpts, replyCfg] = send.mock.calls[0]!;
    expect(replyOpts).toEqual({ replyToMessageId: 42 });
    expect(replyCfg).toEqual(cfg());
    expect(replyText).toContain(formatChannelAck({ channel: 'telegram', dedupeKey: first.ok ? first.envelope.dedupeKey : '', status: 'accepted' }));
    expect(replyText).toContain(`Inbox: ${ORDER}`);

    expect(replyFiles()).toHaveLength(1);
    const reply = readFileSync(join(outboxDir, replyFiles()[0]!), 'utf8');
    expect(reply).toContain(`To: ${MASON_MAIL}`);
    expect(reply).toContain(`In-Reply-To: ${MAIL_ID}`);
    expect(reply).toContain(second.ok ? formatChannelAck(second.ack) : 'unreachable');
    expect(reply).toContain('attached to that instruction');

    // d) re-running the same input is idempotent.
    const telegramRepeat = await telegramOrder();
    const emailRepeat = await emailOrder();
    expect(telegramRepeat).toMatchObject({ ok: true, ack: { channel: 'telegram', status: 'duplicate' } });
    expect(emailRepeat).toMatchObject({ ok: true, ack: { channel: 'email', status: 'duplicate' } });
    expect(inboxText().match(/\[src:/g)).toHaveLength(1);
    expect(parseInbox(inboxText())).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(2); // second Telegram ack, still Telegram-only
    expect(replyFiles()).toHaveLength(1); // same Message-ID stem, rewritten in place
    const after = listBusInboxAfter(0, 50);
    const afterInterjections = after.status === 'ok'
      ? after.messages.filter((row) => (row.envelope.body as { kind?: string }).kind === 'interjection')
      : [];
    expect(afterInterjections).toHaveLength(1);
  });

  it('different order text lands as its own entry (sanity: no over-merge)', async () => {
    await telegramOrder();
    const other = await recordEmailToInbox(
      eml({ id: '<roundtrip-2@mail.example.com>' }).replace(ORDER, 'repave the release lane'),
      { allowedSenders: new Set([MASON_MAIL]), outboxDir, now: () => new Date(T1) },
    );
    expect(other).toMatchObject({ ok: true, ack: { status: 'accepted' } });
    expect(inboxText().match(/\[src:/g)).toHaveLength(2);
    expect(existsSync(inboxPath())).toBe(true);
  });
});
