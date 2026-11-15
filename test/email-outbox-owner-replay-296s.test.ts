/**
 * RQ-PHX-EMAILPOLICYOWNERQUALIFY296S — owner-qualification replay for
 * RQ-PHX-EMAILOUTBOXREGRESS207S (PR #5270), serving Mason's Nov 5
 * accumulated-unique-PR reconciliation and durable Phantom-owned messaging.
 *
 * One mixed outbox directory — a trusted-self reply, an outside reply and a
 * denied reply — runs through the real sendEmailOutbox / readEmailOutbox /
 * listDrafts under the real agent send policy, with a counted fake transport
 * and temporary storage only. No real messages are authorized or sent.
 *
 *   pass 1: self is sent exactly once, the permitted outside reply becomes
 *     exactly one pending draft, the denied reply is refused and stays put.
 *   pass 2: delivered self mail is never resent, the outside draft is never
 *     duplicated, and the refused envelope remains inspectable in the outbox.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEmailOutbox, sendEmailOutbox } from '../src/core/comms/email-outbox.js';
import { validateAgentProfile } from '../src/core/agents/agent-profile.js';
import { listDrafts } from '../src/core/cos/drafts.js';

const SELF = 'self@example.com';
const OUTSIDE = 'outside@example.com';
const BLOCKED = 'blocked@example.com';
const FIXED_NOW = () => new Date('2026-11-13T12:00:00.000Z');

let dir: string;
let runs: string;
let outbox: string;
const sent: { to: string; subject: string; body: string }[] = [];
const transport = async (m: { to: string; subject: string; body: string }) => {
  sent.push({ to: m.to, subject: m.subject, body: m.body });
  return { ok: true as const };
};
const put = (name: string, to: string, tag: string) =>
  writeFileSync(join(outbox, name), `To: ${to}\nSubject: ${tag}\n\nsynthetic ${tag} body\n`);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'email-outbox-owner-replay-296s-'));
  outbox = join(dir, 'outbox'); runs = join(dir, 'runs');
  mkdirSync(outbox, { recursive: true });
  sent.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const profile = validateAgentProfile({
  id: 'helper', displayName: 'Helper', doctrine: 'doctrine.md', channels: ['email'],
  policy: { recipients: { allow: [], deny: [BLOCKED] } },
});
const opts = () => ({
  dir: outbox,
  allowedRecipients: new Set([SELF]),
  transport,
  draftsRunsDir: runs,
  profile,
  now: FIXED_NOW,
});

describe('mixed outbox replay under the real send policy', () => {
  it('pass 1 sends only self once, drafts the outside reply and refuses the denied one', async () => {
    put('a-self.reply.eml', SELF, 'self-reply');
    put('b-outside.reply.eml', OUTSIDE, 'outside-reply');
    put('c-denied.reply.eml', BLOCKED, 'denied-reply');

    const r = await sendEmailOutbox(opts());

    expect(r.sent).toBe(1);
    expect(r.drafted).toBe(1);
    expect(r.refused).toBe(1);
    expect(r.failed).toBe(0);
    expect(r.stuck).toBe(0);
    expect(r.queued).toBe(0);

    // The transport saw exactly one message: the trusted self reply.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: SELF, subject: 'self-reply' });
    expect(sent[0]!.body).toContain('synthetic self-reply body');

    const byName = new Map(r.details.map((d) => [d.name, d]));
    expect(byName.get('a-self.reply.eml')?.outcome).toBe('sent');
    expect(byName.get('b-outside.reply.eml')?.outcome).toBe('drafted');
    expect(byName.get('c-denied.reply.eml')).toMatchObject({ outcome: 'refused', reason: 'recipient-denied' });

    // Real file state: sent/, drafted/ and the refused envelope left queued.
    expect(readdirSync(join(outbox, 'sent'))).toEqual(['a-self.reply.eml']);
    expect(readdirSync(join(outbox, 'drafted'))).toEqual(['b-outside.reply.eml']);
    expect(existsSync(join(outbox, 'c-denied.reply.eml'))).toBe(true);

    // Exactly one pending draft, bound to the outside reply's content.
    const drafts = await listDrafts({ runsDir: runs });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      status: 'pending',
      to: OUTSIDE,
      subject: 'outside-reply',
      source: 'b-outside.reply.eml',
      createdAt: FIXED_NOW().toISOString(),
    });
    expect(drafts[0]!.body).toContain('synthetic outside-reply body');
  });

  it('pass 2 never resends delivered self mail, never duplicates the draft and keeps the refusal inspectable', async () => {
    put('a-self.reply.eml', SELF, 'self-reply');
    put('b-outside.reply.eml', OUTSIDE, 'outside-reply');
    put('c-denied.reply.eml', BLOCKED, 'denied-reply');
    await sendEmailOutbox(opts());
    expect(sent).toHaveLength(1);

    const r2 = await sendEmailOutbox(opts());

    // Only the still-queued denied envelope is touched; it is refused again.
    expect(r2.sent).toBe(0);
    expect(r2.drafted).toBe(0);
    expect(r2.refused).toBe(1);
    expect(r2.failed).toBe(0);
    expect(r2.stuck).toBe(0);
    expect(r2.details).toHaveLength(1);
    expect(r2.details[0]).toMatchObject({ name: 'c-denied.reply.eml', outcome: 'refused', reason: 'recipient-denied' });

    // No resend, no second draft: transport count and draft store are stable.
    expect(sent).toHaveLength(1);
    const drafts = await listDrafts({ runsDir: runs });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ status: 'pending', to: OUTSIDE });

    // Read-only view agrees: one sent, one drafted, one queued refusal.
    const listing = readEmailOutbox(outbox);
    expect(listing.counts).toEqual({ queued: 1, sent: 1, stuck: 0, drafted: 1 });
    const byState = new Map(listing.entries.map((e) => [e.name, e]));
    expect(byState.get('a-self.reply.eml')?.state).toBe('sent');
    expect(byState.get('b-outside.reply.eml')).toMatchObject({ state: 'drafted', to: OUTSIDE });
    expect(byState.get('c-denied.reply.eml')).toMatchObject({ state: 'queued', to: BLOCKED });
    expect(existsSync(join(outbox, 'c-denied.reply.eml'))).toBe(true);
    expect(readdirSync(join(outbox, 'sent'))).toEqual(['a-self.reply.eml']);
    expect(readdirSync(join(outbox, 'drafted'))).toEqual(['b-outside.reply.eml']);
  });
});
