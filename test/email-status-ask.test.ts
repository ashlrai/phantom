import { rememberEmailPair } from '../src/core/fleet/operator-glance-read.js';
/**
 * RQ-PHX-EMAILSTATUSASK143 — a verified Mason email saying "Phantom status"
 * gets the five-line owner digest as its reply `.eml`.
 *
 * Module under test: src/core/comms/email-drop-bridge.ts. An exact, short
 * status ask in the parsed body or subject (isOwnerStatusRequest; the two are
 * checked separately because the channel message body joins them as
 * "subject\n\nbody") is journaled into MASON-INBOX.md like any other order,
 * and a non-duplicate ack carries composeOwnerStatusReply() instead of the
 * generic formatChannelAck text — same To, same Re: threading, same
 * <stem>.reply.eml naming. Duplicates keep the generic receipt, so a replay
 * never re-sends status.
 *
 * Hermetic: HOME, runsDir and the outbox are tmp dirs; the composer is
 * injected; the clock is a fixed fake; senders are example.test fakes; no
 * network, no credentials, no SMTP.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordEmailToInbox } from '../src/core/comms/email-drop-bridge.js';
import { OWNER_STATUS_FALLBACK } from '../src/core/agents/owner-status-reply.js';

const MASON = 'mason@example.test';
const ALLOWED = new Set([MASON]);
const FIXED = new Date('2026-11-11T12:00:00.000Z');
const now = () => FIXED;
const DIGEST = 'Phantom status, 08:00 ET\nShipped (last 12h): none\nNeeds you: none';

let home = '';
let runsDir = '';
let outboxDir = '';
let previousHome: string | undefined;
const roots: string[] = [];

const dir = (prefix: string): string => {
  const path = mkdtempSync(join(tmpdir(), prefix));
  roots.push(path);
  return path;
};

function eml(over: { from?: string; id?: string | null; subject?: string; body?: string } = {}): string {
  const {
    from = `Mason Wyatt <${MASON}>`,
    id = '<msg-1@mail.example.test>',
    subject = 'Fleet note',
    body = 'focus the fleet on billing',
  } = over;
  return [
    `From: ${from}`,
    'To: phantom@example.test',
    `Subject: ${subject}`,
    ...(id === null ? [] : [`Message-ID: ${id}`]),
    'Date: Wed, 11 Nov 2026 08:00:00 -0400',
    'Authentication-Results: mx.example.test; dkim=pass header.d=example.test',
    '',
    body,
    '',
  ].join('\r\n');
}

const inboxPath = () => join(runsDir, 'leader', 'MASON-INBOX.md');
const inboxText = () => readFileSync(inboxPath(), 'utf8');
const replyFiles = () => (existsSync(outboxDir) ? readdirSync(outboxDir).filter((name) => name.endsWith('.reply.eml')).sort() : []);
const replyText = () => readFileSync(join(outboxDir, replyFiles()[0]!), 'utf8');
const record = (raw: string, ownerStatusComposer?: (runsDir: string, now: Date) => Promise<string>) =>
  recordEmailToInbox(raw, { allowedSenders: ALLOWED, runsDir, now, outboxDir, ...(ownerStatusComposer ? { ownerStatusComposer } : {}) });

beforeEach(() => {
  previousHome = process.env['HOME'];
  home = dir('email-status-ask-home-');
  runsDir = dir('email-status-ask-runs-');
  outboxDir = dir('email-status-ask-out-');
  process.env['HOME'] = home;
  rememberEmailPair(MASON, runsDir);
});

afterEach(() => {
  if (previousHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = previousHome;
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

describe('owner "Phantom status" asks over email', () => {
  it('a "Phantom status" body earns the digest reply and still lands in the inbox', async () => {
    const composer = vi.fn(async () => DIGEST);
    const result = await record(eml({ body: 'Phantom status' }), composer);

    expect(result).toMatchObject({ ok: true, ack: { channel: 'email', status: 'accepted' } });
    expect(composer).toHaveBeenCalledWith(runsDir, FIXED);

    // The same threaded reply .eml as any order, with the digest as its body.
    expect(replyFiles()).toEqual(['msg-1_mail.example.test.reply.eml']);
    const reply = replyText();
    expect(reply).toContain(`To: ${MASON}`);
    expect(reply).toContain('Subject: Re: Fleet note');
    expect(reply).toContain('In-Reply-To: <msg-1@mail.example.test>');
    expect(reply).toContain('References: <msg-1@mail.example.test>');
    expect(reply).toContain(DIGEST);
    expect(reply).not.toContain('Received by Phantom');
    expect(reply).not.toContain('Inbox:');

    // The ask is a journaled order: the inbox receipt is unchanged.
    const inbox = inboxText();
    expect(inbox).toContain('[src:email id:email-');
    expect(inbox).toContain('Phantom status');
  });

  it('an ask carried in the subject alone earns the digest too', async () => {
    const composer = vi.fn(async () => DIGEST);
    const result = await record(eml({ subject: 'Phantom status', body: '' }), composer);

    expect(result).toMatchObject({ ok: true, ack: { status: 'accepted' } });
    expect(composer).toHaveBeenCalledTimes(1);
    const reply = replyText();
    expect(reply).toContain('Subject: Re: Phantom status');
    expect(reply).toContain(DIGEST);
    expect(inboxText()).toContain('Phantom status');
  });

  it('the same message redelivered is a duplicate — one reply, no second digest', async () => {
    const composer = vi.fn(async () => DIGEST);
    const first = await record(eml({ body: 'Phantom status' }), composer);
    const second = await record(eml({ body: 'Phantom status' }), composer);

    expect(first).toMatchObject({ ok: true, ack: { status: 'accepted' } });
    expect(second).toMatchObject({ ok: true, ack: { status: 'duplicate' } });
    // The single <stem>.reply.eml is rewritten with the generic receipt; the
    // composer never ran for the replay.
    expect(composer).toHaveBeenCalledTimes(1);
    expect(replyFiles()).toEqual(['msg-1_mail.example.test.reply.eml']);
    const reply = replyText();
    expect(reply).toContain('Already received by Phantom');
    expect(reply).not.toContain(DIGEST);
    expect(inboxText().match(/^\d{4}-\d{2}-\d{2}T[^\n]+ \[src:email/gm)).toHaveLength(1);
  });

  it('an ordinary body keeps the generic ack and never touches the composer', async () => {
    const composer = vi.fn(async () => DIGEST);
    const result = await record(eml({ body: 'please look at the updater' }), composer);

    expect(result).toMatchObject({ ok: true, ack: { status: 'accepted' } });
    expect(composer).not.toHaveBeenCalled();
    const reply = replyText();
    expect(reply).toContain('Received by Phantom');
    expect(reply).toContain('Inbox: Fleet note');
    expect(reply).not.toContain(DIGEST);
  });

  it('an unlisted sender asking "status" is refused silently', async () => {
    const composer = vi.fn(async () => DIGEST);
    const result = await record(eml({ from: 'Stranger <stranger@example.test>', body: 'status' }), composer);

    expect(result).toEqual({ ok: false, reason: 'sender-not-allowed' });
    expect(composer).not.toHaveBeenCalled();
    expect(replyFiles()).toEqual([]);
    expect(existsSync(inboxPath())).toBe(false);
  });

  it('a throwing composer degrades the reply body to the fixed fallback', async () => {
    const result = await record(eml({ body: 'Phantom status' }), async () => { throw new Error('brief read exploded'); });

    expect(result).toMatchObject({ ok: true, ack: { status: 'accepted' } });
    expect(replyFiles()).toEqual(['msg-1_mail.example.test.reply.eml']);
    expect(replyText()).toContain(OWNER_STATUS_FALLBACK);
    expect(inboxText()).toContain('Phantom status');
  });
});
