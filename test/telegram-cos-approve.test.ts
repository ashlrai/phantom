/**
 * RQ-PHX-TELEGRAMCOSAPPROVE16 — Telegram /cos list + /approve.
 *
 * Modules under test: src/core/comms/telegram-cos-approve.ts, reached through
 * the owner-only branches in recordTelegramToInbox (telegram-inbox-bridge.ts).
 *
 * Drafts are real intake artifacts: queueCosEnvelope creates the job and
 * draftCosResult writes the approval-bound draft under <runsDir>/cos/. A fake
 * `send` covers both the command reply and the draft delivery. All ids, chat
 * ids and digests are plainly fake; HOME and runsDir are tmp dirs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordTelegramToInbox } from '../src/core/comms/telegram-inbox-bridge.js';
import {
  approveTelegramCos, formatTelegramCosList, listTelegramCosDrafts,
  type TelegramCosApproveDeps,
} from '../src/core/comms/telegram-cos-approve.js';
import { draftCosResult, queueCosEnvelope, type CosDraft } from '../src/core/cos/intake.js';
import type { InboundEvent, TelegramSendOpts, TelegramSendResult } from '../src/core/integrations/telegram.js';
import type { AshlrConfig } from '../src/core/types.js';

const OWNER = 1234567; // plainly fake Telegram user id
const CHAT = String(OWNER);
const ORIGIN_MSG = '55'; // the inbound question's message id the reply targets
const CMD_MSG = 77;      // the command message the bridge reply targets

function cfg(): AshlrConfig {
  return { comms: { enabled: true, channel: 'telegram', telegram: { botToken: 'fake-token-cos-approve-16', chatId: CHAT } } } as AshlrConfig;
}

function commandEvent(over: Partial<InboundEvent> = {}): InboundEvent {
  return { updateId: 1, kind: 'text', text: '/cos', fromChatId: CHAT, senderUserId: OWNER, privateChat: true, messageId: CMD_MSG, ...over };
}

type FakeSend = ReturnType<typeof vi.fn<(text: string, opts?: TelegramSendOpts, cfg?: AshlrConfig) => Promise<TelegramSendResult>>>;

let home = '';
let runsDir = '';
let previousHome: string | undefined;
let send: FakeSend;
let dedupeSeq = 0;

beforeEach(() => {
  previousHome = process.env['HOME'];
  home = mkdtempSync(join(tmpdir(), 'tg-cos-home-'));
  runsDir = mkdtempSync(join(tmpdir(), 'tg-cos-runs-'));
  process.env['HOME'] = home;
  send = vi.fn(async (): Promise<TelegramSendResult> => ({ ok: true, messageId: 9000 }));
});

afterEach(() => {
  if (previousHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = previousHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(runsDir, { recursive: true, force: true });
});

/** Queues the intake job and writes the draft — the same artifacts the real worker produces. */
async function intakeDraft(input: { channel: 'telegram' | 'email'; verifiedSenderId: string; threadId: string }, reply: string) {
  // cosJobId keeps the first 32 hex of the key — the counter leads so each
  // fixture lands on a distinct job id.
  const dedupeKey = String(dedupeSeq++).padStart(4, 'f') + 'e'.repeat(60);
  const id = await queueCosEnvelope({
    channel: input.channel, verifiedSenderId: input.verifiedSenderId, body: 'Prepare the weekly project brief',
    receivedAt: new Date().toISOString(), dedupeKey, threadId: input.threadId,
  }, runsDir);
  const draft = await draftCosResult(id, reply, runsDir);
  return { id, draft };
}

const telegramDraft = (reply = 'Brief ready.') =>
  intakeDraft({ channel: 'telegram', verifiedSenderId: `telegram:${OWNER}`, threadId: ORIGIN_MSG }, reply);
const emailDraft = (reply = 'Email brief ready.') =>
  intakeDraft({ channel: 'email', verifiedSenderId: 'email:operator@example.test', threadId: 'request@example.test' }, reply);

const draftPath = (id: string) => join(runsDir, 'cos', `${id}.json`);
const deliveryPath = (id: string) => join(runsDir, 'cos', `${id}.delivery.json`);
const approveLine = (id: string, draft: CosDraft) => `/approve ${id} ${draft.digest.slice(0, 12)}`;

describe('/cos', () => {
  it('lists a waiting Telegram draft with its copy-paste approve line', async () => {
    const { id, draft } = await telegramDraft();
    const config = cfg();
    const result = await recordTelegramToInbox(commandEvent(), '/cos', config, { send, runsDir });
    expect(result).toEqual({ ok: false, reason: 'status-replied' });
    expect(send).toHaveBeenCalledTimes(1);
    const [body, opts, passedCfg] = send.mock.calls[0]!;
    expect(body).toContain('Brief ready.');
    expect(body).toContain(`/approve ${id} ${draft.digest.slice(0, 12)}`);
    expect(opts).toEqual({ replyToMessageId: CMD_MSG });
    expect(passedCfg).toBe(config);
    // The command never reaches the inbox or the queue.
    expect(existsSync(join(runsDir, 'leader', 'MASON-INBOX.md'))).toBe(false);
    expect(await listTelegramCosDrafts(runsDir)).toHaveLength(1);
  });

  it('replies with the empty-list line when nothing waits', async () => {
    const result = await recordTelegramToInbox(commandEvent(), '/cos', cfg(), { send, runsDir });
    expect(result).toEqual({ ok: false, reason: 'status-replied' });
    expect(send.mock.calls[0]![0]).toBe('No Telegram replies are waiting for approval.');
  });

  it('lists newest first, at most three', async () => {
    const a = await telegramDraft('Reply one');
    const b = await telegramDraft('Reply two');
    const c = await telegramDraft('Reply three');
    const d = await telegramDraft('Reply four');
    // Force a deterministic order: a oldest, d's own mtime is already newest.
    for (const [i, entry] of [a, b, c].entries()) {
      const when = new Date(1_000_000 + i * 1_000);
      utimesSync(draftPath(entry.id), when, when);
    }
    const listed = await listTelegramCosDrafts(runsDir);
    expect(listed.map(draft => draft.id)).toEqual([d.id, c.id, b.id]);
  });

  it('hides email-origin and already-claimed drafts', async () => {
    const tg = await telegramDraft();
    const em = await emailDraft();
    const sent = await telegramDraft('Already sent reply');
    writeFileSync(deliveryPath(sent.id), JSON.stringify({ state: 'sent' }), { mode: 0o600 });

    const listed = await listTelegramCosDrafts(runsDir);
    expect(listed.map(draft => draft.id)).toEqual([tg.id]);

    const result = await recordTelegramToInbox(commandEvent(), '/cos', cfg(), { send, runsDir });
    expect(result).toEqual({ ok: false, reason: 'status-replied' });
    const body = send.mock.calls[0]![0];
    expect(body).toContain('Brief ready.');
    expect(body).not.toContain('Email brief ready.');
    expect(body).not.toContain(em.id);
    expect(body).not.toContain(sent.id);
  });

  it('skips symlinks and entries cosStatus cannot read', async () => {
    const { id } = await telegramDraft();
    // A symlink named like a draft must not be followed or listed.
    symlinkSync(draftPath(id), join(runsDir, 'cos', `cos-${'0'.repeat(32)}.json`));
    // An orphan draft file with no queue job fails cosStatus and is skipped.
    writeFileSync(join(runsDir, 'cos', `cos-${'1'.repeat(32)}.json`), JSON.stringify({
      id: `cos-${'1'.repeat(32)}`, origin: { channel: 'telegram', senderId: `telegram:${OWNER}` },
      text: 'orphan', digest: 'f'.repeat(64),
    }), { mode: 0o600 });
    const listed = await listTelegramCosDrafts(runsDir);
    expect(listed.map(draft => draft.id)).toEqual([id]);
  });

  it('truncates a draft past 3000 chars and says so', async () => {
    const { draft } = await telegramDraft(`start-${'x'.repeat(3_500)}-end`);
    const text = formatTelegramCosList([draft]);
    expect(text).toContain(`start-${'x'.repeat(2_994)}`);
    expect(text).not.toContain('x'.repeat(3_000));
    expect(text).toContain('[truncated]');
    expect(text).toContain(`/approve ${draft.id} ${draft.digest.slice(0, 12)}`);
  });

  it('reports a failed reply send as status-send-failed', async () => {
    await telegramDraft();
    send.mockRejectedValue(new Error('fake telegram outage'));
    const result = await recordTelegramToInbox(commandEvent(), '/cos', cfg(), { send, runsDir });
    expect(result).toEqual({ ok: false, reason: 'status-send-failed' });
  });
});

describe('/approve', () => {
  it('the right code sends the stored draft once, then reports already sent', async () => {
    const { id, draft } = await telegramDraft();
    const result = await recordTelegramToInbox(commandEvent(), approveLine(id, draft), cfg(), { send, runsDir });
    expect(result).toEqual({ ok: false, reason: 'status-replied' });
    // First the draft goes out as a reply to its originating question…
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![0]).toBe('Brief ready.');
    expect(send.mock.calls[0]![1]).toEqual({ replyToMessageId: 55 });
    // …then the command gets its own reply.
    expect(send.mock.calls[1]![0]).toBe('Sent.');
    expect(send.mock.calls[1]![1]).toEqual({ replyToMessageId: CMD_MSG });
    expect(JSON.parse(readFileSync(deliveryPath(id), 'utf8'))).toEqual({ state: 'sent' });

    const again = await recordTelegramToInbox(commandEvent({ messageId: 78 }), approveLine(id, draft), cfg(), { send, runsDir });
    expect(again).toEqual({ ok: false, reason: 'status-replied' });
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[2]![0]).toBe('Already sent or in progress.');
    // And the sent draft leaves the waiting list.
    expect(await listTelegramCosDrafts(runsDir)).toEqual([]);
  });

  it('a wrong code sends nothing and leaves no delivery claim', async () => {
    const { id, draft } = await telegramDraft();
    const wrong = draft.digest.slice(0, 12) === 'f'.repeat(12) ? 'e'.repeat(12) : 'f'.repeat(12);
    const result = await recordTelegramToInbox(commandEvent(), `/approve ${id} ${wrong}`, cfg(), { send, runsDir });
    expect(result).toEqual({ ok: false, reason: 'status-replied' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe('That code does not match the current draft.');
    expect(send.mock.calls[0]![0]).not.toContain('Brief ready.');
    expect(existsSync(deliveryPath(id))).toBe(false);
  });

  it('an email-origin draft is not listed and cannot be approved here', async () => {
    const { id, draft } = await emailDraft();
    expect(await listTelegramCosDrafts(runsDir)).toEqual([]);
    const result = await recordTelegramToInbox(commandEvent(), approveLine(id, draft), cfg(), { send, runsDir });
    expect(result).toEqual({ ok: false, reason: 'status-replied' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe('That code does not match the current draft.');
    expect(existsSync(deliveryPath(id))).toBe(false);
  });

  it('a send failure says "Delivery uncertain" and the claim blocks a repeat', async () => {
    const { id, draft } = await telegramDraft();
    send.mockResolvedValueOnce({ ok: false }); // only the draft delivery fails
    const result = await recordTelegramToInbox(commandEvent(), approveLine(id, draft), cfg(), { send, runsDir });
    expect(result).toEqual({ ok: false, reason: 'status-replied' });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0]).toBe('Delivery uncertain; check the chat, then settle it in the desktop Tasks card.');
    expect(send.mock.calls[1]![1]).toEqual({ replyToMessageId: CMD_MSG });
    expect(JSON.parse(readFileSync(deliveryPath(id), 'utf8'))).toEqual({ state: 'uncertain' });

    const again = await recordTelegramToInbox(commandEvent({ messageId: 78 }), approveLine(id, draft), cfg(), { send, runsDir });
    expect(again).toEqual({ ok: false, reason: 'status-replied' });
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[2]![0]).toBe('Already sent or in progress.');
  });

  it('an unknown job id sends nothing but the refusal', async () => {
    const result = await recordTelegramToInbox(
      commandEvent(), `/approve cos-${'a'.repeat(32)} ${'b'.repeat(12)}`, cfg(), { send, runsDir });
    expect(result).toEqual({ ok: false, reason: 'status-replied' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe('That code does not match the current draft.');
  });

  it('an in-flight claim says already sent or in progress', async () => {
    const { id, draft } = await telegramDraft();
    writeFileSync(deliveryPath(id), JSON.stringify({ state: 'sending' }), { mode: 0o600 });
    const result = await recordTelegramToInbox(commandEvent(), approveLine(id, draft), cfg(), { send, runsDir });
    expect(result).toEqual({ ok: false, reason: 'status-replied' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe('Already sent or in progress.');
  });

  it('never throws: a failed delivery reports uncertain, malformed text refuses', async () => {
    const { id, draft } = await telegramDraft();
    const deps: TelegramCosApproveDeps = {
      runsDir,
      deliver: async () => { throw new Error('transport down'); },
    };
    await expect(approveTelegramCos(approveLine(id, draft), cfg(), deps))
      .resolves.toBe('Delivery uncertain; check the chat, then settle it in the desktop Tasks card.');
    await expect(approveTelegramCos('not a command at all', cfg(), deps))
      .resolves.toBe('That code does not match the current draft.');
  });
});

describe('owner gate', () => {
  it.each([
    '/cos',
    `/approve cos-${'a'.repeat(32)} ${'b'.repeat(12)}`,
  ])('non-owner sender on %s: silence, sender-not-allowed', async (text) => {
    await telegramDraft();
    const result = await recordTelegramToInbox(commandEvent({ senderUserId: 7654321 }), text, cfg(), { send, runsDir });
    expect(result).toEqual({ ok: false, reason: 'sender-not-allowed' });
    expect(send).not.toHaveBeenCalled();
  });

  it('an unverified event shape gets silence before any command branch', async () => {
    await telegramDraft();
    const result = await recordTelegramToInbox(commandEvent({ privateChat: false }), '/cos', cfg(), { send, runsDir });
    expect(result).toEqual({ ok: false, reason: 'sender-not-allowed' });
    expect(send).not.toHaveBeenCalled();
  });
});
