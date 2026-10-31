/**
 * RQ-PHX-EMAILDROPCHANNEL31 — drop-folder email → MASON-INBOX.md bridge.
 *
 * Module under test: src/core/comms/email-drop-bridge.ts (this file sits beside
 * it, like src/core/fleet/order-trace.test.ts and the verse co-located suites).
 *
 * A raw `.eml` from an allowed sender lands in <runsDir>/leader/MASON-INBOX.md
 * through the shared channel receiver — channel `email`, sender
 * `email:<address>` — mirrors once onto the agent bus, and is acknowledged as a
 * reply `.eml` in the outbox carrying formatChannelAck() plus an `Inbox:`
 * preview and In-Reply-To/References threading. A repeated Message-ID is a
 * duplicate via <runsDir>/queue/email-drop-seen.jsonl; an unlisted sender is
 * refused silently (no inbox write, no reply); a malformed file fails alone.
 *
 * Hermetic: HOME, runsDir, busRoot and the drop folders are all tmp dirs; the
 * clock is a fixed fake; no network, no credentials.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  emailChannelMessage,
  parseEmlMessage,
  recordEmailToInbox,
  runEmailDropOnce,
} from './email-drop-bridge.js';
import { formatChannelAck } from '../fleet/channel-ack-text.js';
import { listBusInboxAfter } from '../fleet/bus-inbox.js';

const MASON = 'mason@example.com';
const ALLOWED = new Set([MASON]);
const FIXED = new Date('2026-10-31T12:00:00.000Z');
const now = () => FIXED;

let home = '';
let runsDir = '';
let inboxDir = '';
let outboxDir = '';
let processedDir = '';
let previousHome: string | undefined;
const roots: string[] = [];

const dir = (prefix: string): string => {
  const path = mkdtempSync(join(tmpdir(), prefix));
  roots.push(path);
  return path;
};

function eml(over: { from?: string; id?: string | null; subject?: string; body?: string; extraHeaders?: string } = {}): string {
  const {
    from = `Mason Wyatt <${MASON}>`,
    id = '<msg-1@mail.example.com>',
    subject = 'Fleet note',
    body = 'focus the fleet on billing',
    extraHeaders = '',
  } = over;
  return [
    `From: ${from}`,
    `To: phantom@example.com`,
    `Subject: ${subject}`,
    ...(id === null ? [] : [`Message-ID: ${id}`]),
    'Date: Fri, 31 Oct 2026 08:00:00 -0400',
    ...(extraHeaders ? [extraHeaders] : []),
    '',
    body,
    '',
  ].join('\r\n');
}

const inboxPath = () => join(runsDir, 'leader', 'MASON-INBOX.md');
const inboxText = () => readFileSync(inboxPath(), 'utf8');
const inboxHeadings = () => (existsSync(inboxPath()) ? inboxText().match(/^## /gm) ?? [] : []);
const replyFiles = () => readdirSync(outboxDir).filter((name) => name.endsWith('.reply.eml')).sort();
const drop = (name: string, raw: string) => writeFileSync(join(inboxDir, name), raw, 'utf8');
const runOpts = () => ({ inboxDir, outboxDir, processedDir, allowedSenders: ALLOWED, runsDir, now });

beforeEach(() => {
  previousHome = process.env['HOME'];
  home = dir('email-drop-home-');
  runsDir = dir('email-drop-runs-');
  inboxDir = dir('email-drop-in-');
  outboxDir = dir('email-drop-out-');
  processedDir = dir('email-drop-done-');
  process.env['HOME'] = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = previousHome;
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

describe('parseEmlMessage', () => {
  it('parses From, Message-ID, Subject and body; unfolds headers; lowercases the address', () => {
    const parsed = parseEmlMessage(eml({
      from: 'Mason Wyatt <MASON@Example.COM>',
      extraHeaders: 'X-Long-Header: first\r\n\tsecond',
    }));
    expect(parsed).toMatchObject({
      from: MASON,
      messageId: 'msg-1@mail.example.com',
      subject: 'Fleet note',
    });
    expect(parsed!.body).toContain('focus the fleet on billing');
    expect(parseEmlMessage(eml({ extraHeaders: 'In-Reply-To: <parent-9@x>' }))!.inReplyTo).toBe('parent-9@x');
  });

  it('returns null without a parseable From', () => {
    expect(parseEmlMessage('Subject: hi\r\n\r\nbody')).toBeNull();
    expect(parseEmlMessage('From: no address here\r\n\r\nbody')).toBeNull();
    expect(parseEmlMessage('')).toBeNull();
  });
});

describe('recordEmailToInbox + runEmailDropOnce', () => {
  it('accepted sender: inbox entry attributed to email + one threaded reply', async () => {
    const raw = eml();
    const result = await recordEmailToInbox(raw, { allowedSenders: ALLOWED, runsDir, now, outboxDir });
    expect(result).toMatchObject({ ok: true, ack: { channel: 'email', status: 'accepted' } });
    expect(result.ok && result.envelope.verifiedSenderId).toBe(`email:${MASON}`);

    const inbox = inboxText();
    expect(inbox.match(/^## /gm)).toHaveLength(1);
    expect(inbox).toContain('(Mason, email)');
    expect(inbox).toContain('Fleet note');
    expect(inbox).toContain('focus the fleet on billing');

    const replies = replyFiles();
    expect(replies).toHaveLength(1);
    const reply = readFileSync(join(outboxDir, replies[0]!), 'utf8');
    expect(reply).toContain(`To: ${MASON}`);
    expect(reply).toContain('Subject: Re: Fleet note');
    expect(reply).toContain('In-Reply-To: <msg-1@mail.example.com>');
    expect(reply).toContain('References: <msg-1@mail.example.com>');
    expect(reply).toContain(result.ok ? formatChannelAck(result.ack) : 'unreachable');
    expect(reply).toContain('Inbox: Fleet note');
  });

  it('same Message-ID dropped twice: duplicate on the second pass, one inbox entry', async () => {
    drop('a.eml', eml());
    expect(await runEmailDropOnce(runOpts())).toEqual({ accepted: 1, duplicate: 0, refused: 0, failed: 0 });
    drop('a.eml', eml());
    expect(await runEmailDropOnce(runOpts())).toEqual({ accepted: 0, duplicate: 1, refused: 0, failed: 0 });
    expect(inboxHeadings()).toHaveLength(1);
    expect(readdirSync(processedDir).sort()).toEqual(['a.eml', 'a.eml.1']);
    expect(replyFiles()).toHaveLength(1);
    const reply = readFileSync(join(outboxDir, replyFiles()[0]!), 'utf8');
    expect(reply).toContain('Already received by Phantom');
  });

  it('unlisted sender: refused — no inbox entry, no reply, file still processed', async () => {
    drop('b.eml', eml({ from: 'Stranger <stranger@example.net>', id: '<stranger-1@x>' }));
    drop('c.eml', eml({ id: '<ok-1@x>' }));
    expect(await runEmailDropOnce(runOpts())).toEqual({ accepted: 1, duplicate: 0, refused: 1, failed: 0 });
    expect(inboxHeadings()).toHaveLength(1);
    expect(inboxText()).not.toContain('stranger');
    expect(replyFiles()).toHaveLength(1);
    expect(readdirSync(processedDir).sort()).toEqual(['b.eml', 'c.eml']);
  });

  it('multipart: first text/plain part only, quoted lines and signature stripped', async () => {
    const raw = [
      `From: ${MASON}`,
      'Subject: Multipart test',
      'Message-ID: <mp-1@x>',
      'Content-Type: multipart/alternative; boundary="BOUND"',
      '',
      'preamble never counted',
      '--BOUND',
      'Content-Type: text/html',
      '',
      '<html><body>markup</body></html>',
      '--BOUND',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'plain words here',
      '> quoted reply line',
      '-- ',
      'signature block',
      '--BOUND--',
      '',
    ].join('\r\n');
    const parsed = parseEmlMessage(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.body).toBe('plain words here');
    const message = emailChannelMessage(parsed!, ALLOWED);
    expect(message).toEqual({
      channel: 'email',
      verifiedSenderId: `email:${MASON}`,
      body: 'Multipart test\n\nplain words here',
    });

    drop('m.eml', raw);
    expect(await runEmailDropOnce(runOpts())).toEqual({ accepted: 1, duplicate: 0, refused: 0, failed: 0 });
    const inbox = inboxText();
    expect(inbox).toContain('plain words here');
    expect(inbox).not.toContain('markup');
    expect(inbox).not.toContain('quoted reply line');
    expect(inbox).not.toContain('signature block');
    expect(inbox).not.toContain('preamble');
  });

  it('malformed file: failed, and the pass continues with the next file', async () => {
    drop('1-bad.eml', 'this is not an email at all\r\n\r\nno from header');
    drop('2-good.eml', eml({ id: '<good-1@x>' }));
    expect(await runEmailDropOnce(runOpts())).toEqual({ accepted: 1, duplicate: 0, refused: 0, failed: 1 });
    expect(inboxHeadings()).toHaveLength(1);
    expect(readdirSync(processedDir).sort()).toEqual(['1-bad.eml', '2-good.eml']);
  });

  it('bus mirror: one interjection entry for an accepted message', async () => {
    const busRoot = dir('email-drop-bus-');
    const result = await recordEmailToInbox(eml(), { allowedSenders: ALLOWED, runsDir, now, outboxDir, busRoot });
    expect(result).toMatchObject({ ok: true, ack: { status: 'accepted' }, publishState: 'published' });
    const page = listBusInboxAfter(0, 50, { root: busRoot });
    if (page.status !== 'ok') throw new Error(`bus read failed: ${page.status}`);
    expect(page.messages).toHaveLength(1);
    const envelope = page.messages[0]!.envelope;
    expect(envelope.from).toBe('mason');
    expect(envelope.to).toBe('leaders');
    expect(envelope.id).toMatch(/^mason-email-[a-f0-9]{16}$/);
    expect(envelope.body).toMatchObject({
      kind: 'interjection',
      channel: 'email',
      text: expect.stringContaining('focus the fleet on billing'),
      dedupeKey: result.ok ? result.envelope.dedupeKey : '',
    });
  });

  it('body cap: an oversized body is capped at 8 KB', () => {
    const parsed = parseEmlMessage(eml({ id: null, body: 'x'.repeat(16 * 1024) }));
    expect(parsed).not.toBeNull();
    expect(Buffer.byteLength(parsed!.body, 'utf8')).toBeLessThanOrEqual(8 * 1024);
  });
});
