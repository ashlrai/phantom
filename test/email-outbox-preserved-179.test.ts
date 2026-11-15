/**
 * RQ-PHX-EMAILOUTBOXCOVER179 — preserved regression coverage from Phantom PR
 * #5158 (pinned head 70ad60aac3e3266e2e251d25d7d764aa04e2d652, bridge
 * RQ-PHX-RECUTCOMMSC177), serving Mason t1618u/t1634u and the Nov 5
 * backlog-preservation order: the comms email outbox must safely draft
 * outside replies while permitting verified self delivery.
 *
 * Consolidated from the PR's three test files; every case calls the real
 * sendEmailOutbox / checkSend / validateAgentProfile / listDrafts — no
 * reimplemented logic, mocked transport, temporary storage only.
 *
 *   - test/recut-c148-commso1.test.ts — UNIQUE on master: one mixed batch
 *     (self sent, outside drafted, denied refused in a single pass) and a
 *     refused envelope surviving to be drafted by a later pass.
 *   - test/send-policy-email-outbox.test.ts — each case has an equivalent on
 *     master in test/recut-comms-old-c160.test.ts; the unlisted-channel and
 *     portable-allowlist cases are kept here deduplicated into the shared
 *     fixture so this preserved file stands alone.
 *   - test/send-policy.test.ts — verbatim duplicate of master's
 *     test/agent-send-decision.test.ts; only the two limit assertions the
 *     outbox path cannot distinguish (limits-incomplete and daily-cap both
 *     surface as `drafted`) are kept as direct checkSend cases.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendEmailOutbox } from '../src/core/comms/email-outbox.js';
import { validateAgentProfile } from '../src/core/agents/agent-profile.js';
import { checkSend } from '../src/core/agents/send-policy.js';
import { listDrafts } from '../src/core/cos/drafts.js';

const SELF = 'self@example.com';
const OUTSIDE = 'outside@example.com';
const BLOCKED = 'blocked@example.com';

let dir: string;
let runs: string;
let outbox: string;
const sent: string[] = [];
const transport = async (m: { to: string }) => { sent.push(m.to); return { ok: true as const }; };
const put = (name: string, to: string) =>
  writeFileSync(join(outbox, name), `To: ${to}\nSubject: hello\n\nsynthetic body\n`);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'email-outbox-preserved-179-'));
  outbox = join(dir, 'outbox'); runs = join(dir, 'runs');
  mkdirSync(outbox, { recursive: true });
  sent.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const base = () => ({ dir: outbox, allowedRecipients: new Set([SELF]), transport, draftsRunsDir: runs });
const profile = (policy?: Record<string, unknown>, channels: string[] = ['email']) =>
  validateAgentProfile({ id: 'helper', displayName: 'Helper', doctrine: 'doctrine.md', channels, policy });

describe('email outbox preserved coverage (PR #5158)', () => {
  it('one pass sends only verified self, drafts the outside reply and refuses the denied one', async () => {
    put('a.reply.eml', SELF);
    put('b.reply.eml', OUTSIDE);
    put('c.reply.eml', BLOCKED);
    const r = await sendEmailOutbox({ ...base(), profile: profile({ recipients: { allow: [], deny: [BLOCKED] } }) });
    expect(r.sent).toBe(1);
    expect(r.drafted).toBe(1);
    expect(r.refused).toBe(1);
    expect(sent).toEqual([SELF]);
    const byName = new Map(r.details.map((d) => [d.name, d]));
    expect(byName.get('a.reply.eml')?.outcome).toBe('sent');
    expect(byName.get('b.reply.eml')?.outcome).toBe('drafted');
    expect(byName.get('c.reply.eml')).toMatchObject({ outcome: 'refused', reason: 'recipient-denied' });
    // The refused envelope stays put for a later pass; it is never moved or sent.
    expect(existsSync(join(outbox, 'c.reply.eml'))).toBe(true);
    expect(readdirSync(join(outbox, 'sent'))).toEqual(['a.reply.eml']);
    expect(readdirSync(join(outbox, 'drafted'))).toEqual(['b.reply.eml']);
    // The draft is durable: pending, bound to the reply's content and source.
    const drafts = await listDrafts({ runsDir: runs });
    expect(drafts.map((d) => d.to)).toEqual([OUTSIDE]);
    expect(drafts[0]).toMatchObject({
      status: 'pending',
      subject: 'hello',
      body: expect.stringContaining('synthetic body'),
      source: 'b.reply.eml',
    });
  });

  it('a refused envelope survives the pass and can be drafted by a later one', async () => {
    put('a.reply.eml', BLOCKED);
    const denying = profile({ recipients: { allow: [], deny: [BLOCKED] } });
    const first = await sendEmailOutbox({ ...base(), profile: denying });
    expect(first.refused).toBe(1);
    expect(existsSync(join(outbox, 'a.reply.eml'))).toBe(true);
    // Same envelope, default fail-closed profile: it drafts rather than sending.
    const second = await sendEmailOutbox(base());
    expect(second.refused).toBe(0);
    expect(second.drafted).toBe(1);
    expect(sent).toEqual([]);
    expect((await listDrafts({ runsDir: runs })).map((d) => d.to)).toEqual([BLOCKED]);
  });

  it('refuses an outside send when the profile does not list the email channel', async () => {
    put('a.reply.eml', OUTSIDE);
    const r = await sendEmailOutbox({ ...base(), profile: profile(undefined, []) });
    expect(r.refused).toBe(1);
    expect(r.details[0]?.reason).toBe('channel-not-listed');
    expect(await listDrafts({ runsDir: runs })).toEqual([]);
    expect(existsSync(join(outbox, 'a.reply.eml'))).toBe(true);
  });

  it('a portable allowlist never establishes verified self: the outside send still drafts', async () => {
    put('a.reply.eml', OUTSIDE);
    const p = profile({
      send: 'allowlist-auto', perMessageApproval: false, limitsTodo: false,
      recipients: { allow: [OUTSIDE], deny: [] },
    });
    const r = await sendEmailOutbox({ ...base(), profile: p });
    // A portable allowlist can never prove verified self: best case is draft.
    expect(r.drafted).toBe(1);
    expect(r.sent).toBe(0);
    expect(sent).toEqual([]);
  });
});

describe('checkSend limits preserved from test/send-policy.test.ts', () => {
  // The outbox always reports both of these as `drafted`; the reasons are only
  // visible on the direct decision, so these two cases stay at checkSend level.
  const p = profile({
    send: 'allowlist-auto', perMessageApproval: false,
    recipients: { allow: [SELF], deny: [BLOCKED] },
  });

  it('limitsTodo forces a draft', () => {
    expect(checkSend(p, 'email', SELF, 0)).toEqual({ decision: 'draft', reason: 'limits-incomplete' });
  });

  it('daily cap reached requires a draft', () => {
    const settled = structuredClone(p);
    settled.policy.limitsTodo = false;
    settled.policy.dailyCap = 1;
    expect(checkSend(settled, 'email', SELF, 1).reason).toBe('daily-cap-reached');
  });
});
