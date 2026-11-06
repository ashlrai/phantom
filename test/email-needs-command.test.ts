import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordEmailToInbox } from '../src/core/comms/email-drop-bridge.js';
import { isEmailNeedsCommand } from '../src/core/comms/email-needs-command.js';
import { rememberEmailPair } from '../src/core/fleet/operator-glance-read.js';
import { listNeedsMason } from '../src/core/fleet/needs-mason-resolve.js';

const OWNER = 'owner@example.test';
const now = () => new Date('2026-10-31T12:00:00.000Z');
const roots: string[] = [];
let previousHome: string | undefined;
let runsDir = '';
let outboxDir = '';
let busRoot = '';

const dir = (prefix: string): string => {
  const path = mkdtempSync(join(tmpdir(), prefix));
  roots.push(path);
  return path;
};

const mail = (body: string, id = '<cmd-1@mail.example.test>', from = OWNER): string => [
  `From: ${from}`, 'To: phantom@example.test', 'Subject: fleet', `Message-ID: ${id}`,
  'Authentication-Results: mx.example.test; dkim=pass header.d=example.test', '', body, '',
].join('\r\n');

const send = (raw: string, allowed: string[] = [OWNER]) =>
  recordEmailToInbox(raw, { allowedSenders: new Set(allowed), runsDir, now, outboxDir, busRoot });
const replies = () => readdirSync(outboxDir).filter(name => name.startsWith('needs-'));
const replyText = () => readFileSync(join(outboxDir, replies()[0]!), 'utf8');
const inboxFile = () => join(runsDir, 'leader', 'MASON-INBOX.md');
const needsFile = () => join(runsDir, 'NEEDS-MASON.md');

beforeEach(() => {
  previousHome = process.env['HOME'];
  process.env['HOME'] = dir('email-needs-home-');
  runsDir = dir('email-needs-runs-');
  outboxDir = dir('email-needs-out-');
  busRoot = dir('email-needs-bus-');
  rememberEmailPair(OWNER, runsDir);
  writeFileSync(needsFile(), '# Needs Mason\n- [ ] Pick a fake color\n');
});

afterEach(() => {
  if (previousHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = previousHome;
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

const itemId = () => listNeedsMason({ runsDir })[0]!.id;

describe('isEmailNeedsCommand', () => {
  it('matches whole-word /needs and /resolve on the first non-empty line only', () => {
    expect(isEmailNeedsCommand('/needs')).toBe(true);
    expect(isEmailNeedsCommand('\n  /NEEDS please')).toBe(true);
    expect(isEmailNeedsCommand('/resolve nm-000000000000 ok')).toBe(true);
    expect(isEmailNeedsCommand('/needsmore')).toBe(false);
    expect(isEmailNeedsCommand('hello\n/needs')).toBe(false);
    expect(isEmailNeedsCommand('')).toBe(false);
  });
});

describe('email needs commands through recordEmailToInbox', () => {
  it('/needs replies with the open items and writes no inbox entry', async () => {
    const id = itemId();
    expect(await send(mail('/needs'))).toEqual({ ok: false, kind: 'status', reason: 'status-queued' });
    expect(replies()).toHaveLength(1);
    const reply = replyText();
    expect(reply).toContain(`To: ${OWNER}`);
    expect(reply).toContain('Subject: Re: Phantom needs');
    expect(reply).toContain('In-Reply-To: <cmd-1@mail.example.test>');
    expect(reply).toContain(`${id}: Pick a fake color`);
    expect(existsSync(inboxFile())).toBe(false);
  });

  it('/resolve resolves the item and relays the reply into the inbox', async () => {
    const id = itemId();
    expect(await send(mail(`/resolve ${id} go ahead`))).toMatchObject({ reason: 'status-queued' });
    expect(replyText()).toContain(`Resolved ${id}.`);
    expect(readFileSync(needsFile(), 'utf8')).toMatch(new RegExp(`\\[x\\] resolved ${id}`));
    const inbox = readFileSync(inboxFile(), 'utf8');
    expect(inbox.match(/go ahead/g)).toHaveLength(1);
    // The `[src:email` label comes from INBOX_SOURCE in needs-mason-relay.ts (edited by another job).
  });

  it('a redelivered mail returns status-duplicate and writes no second reply', async () => {
    const raw = mail(`/resolve ${itemId()} go ahead`);
    await send(raw);
    expect(await send(raw)).toEqual({ ok: false, kind: 'status', reason: 'status-duplicate' });
    expect(replies()).toHaveLength(1);
    expect(readFileSync(inboxFile(), 'utf8').match(/go ahead/g)).toHaveLength(1);
  });

  it('an unknown id is refused in the reply', async () => {
    await send(mail('/resolve nm-000000000000'));
    expect(replyText()).toContain('Resolve refused: no such needs-you item.');
  });

  it('a sender off the allowlist gets no reply and the item stays open', async () => {
    const id = itemId();
    expect(await send(mail(`/resolve ${id} go ahead`), ['other@example.test'])).toMatchObject({ ok: false, reason: 'sender-not-allowed' });
    expect(readdirSync(outboxDir)).toHaveLength(0);
    expect(listNeedsMason({ runsDir }).map(item => item.id)).toContain(id);
  });
});
