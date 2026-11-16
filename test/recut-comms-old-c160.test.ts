/**
 * RQ-PHX-RECUTCOMMSOLDC160 — recut of #3511 (bridge RQ-AGENTPROFILE-1).
 *
 * The PR's portable agent profiles (agent-profile.ts), the fail-closed send
 * policy (send-policy.ts), the `phm agents` dispatcher and the profile docs
 * all landed on master already — including its send-policy test verbatim as
 * test/agent-send-decision.test.ts. The piece that never landed is the outbox
 * half of the intent: an outside send (To not on the owner's allowlist)
 * answers to the agent send policy instead of drafting unconditionally.
 *
 * These tests pin the landed wiring through the real modules: a `deny`
 * decision refuses the reply where it stands, a `draft` decision — the best
 * a portable profile can ever yield — keeps the owner's approve/reject path,
 * and the allowlisted trusted-recipient binding still reaches the transport.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendEmailOutbox, type EmailOutboxMessage } from '../src/core/comms/email-outbox.js';
import { validateAgentProfile } from '../src/core/agents/agent-profile.js';
import { listDrafts } from '../src/core/cos/drafts.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const OWNER = 'operator@example.test';
const OUTSIDER = 'outside@example.test';
const BLOCKED = 'blocked@example.test';

function fixture(): { root: string; outbox: string; runs: string } {
  const root = mkdtempSync(join(tmpdir(), 'recut-comms-old-c160-'));
  roots.push(root);
  const outbox = join(root, 'outbox');
  const runs = join(root, 'runs');
  mkdirSync(outbox, { recursive: true });
  return { root, outbox, runs };
}

const reply = (outbox: string, name: string, to: string): void =>
  writeFileSync(join(outbox, name), `To: ${to}\r\nSubject: Re: status\r\n\r\nack body\r\n`);

const sent: EmailOutboxMessage[] = [];
const transport = async (m: EmailOutboxMessage) => { sent.push(m); return { ok: true as const }; };

const base = (outbox: string, runs: string) => ({
  dir: outbox,
  allowedRecipients: new Set([OWNER]),
  transport,
  draftsRunsDir: runs,
});

const profile = (policy: Record<string, unknown>, channels: string[] = ['email']) =>
  validateAgentProfile({ id: 'helper', displayName: 'Helper', doctrine: 'doctrine.md', channels, policy });

describe('recut-comms-old-c160: outbox send policy', () => {
  it('drafts an outside send under the fail-closed default profile', async () => {
    sent.length = 0;
    const { outbox, runs } = fixture();
    reply(outbox, 'a.reply.eml', OUTSIDER);
    const r = await sendEmailOutbox(base(outbox, runs));
    expect(r.drafted).toBe(1);
    expect(r.sent).toBe(0);
    expect(r.refused).toBe(0);
    expect(sent).toEqual([]);
    expect((await listDrafts({ runsDir: runs })).map(d => d.to)).toEqual([OUTSIDER]);
    expect(readdirSync(join(outbox, 'drafted'))).toEqual(['a.reply.eml']);
  });

  it('refuses a denied recipient without drafting or moving the reply', async () => {
    sent.length = 0;
    const { outbox, runs } = fixture();
    reply(outbox, 'a.reply.eml', BLOCKED);
    const r = await sendEmailOutbox({
      ...base(outbox, runs),
      profile: profile({ send: 'allowlist-auto', perMessageApproval: false, limitsTodo: false, recipients: { allow: [], deny: [BLOCKED] } }),
    });
    expect(r.refused).toBe(1);
    expect(r.drafted).toBe(0);
    expect(r.details[0]).toMatchObject({ name: 'a.reply.eml', outcome: 'refused', to: BLOCKED, reason: 'recipient-denied' });
    expect(await listDrafts({ runsDir: runs })).toEqual([]);
    expect(existsSync(join(outbox, 'a.reply.eml'))).toBe(true);
    expect(sent).toEqual([]);
  });

  it('refuses an outside send when the profile does not list the email channel', async () => {
    sent.length = 0;
    const { outbox, runs } = fixture();
    reply(outbox, 'a.reply.eml', OUTSIDER);
    const r = await sendEmailOutbox({ ...base(outbox, runs), profile: profile({}, []) });
    expect(r.refused).toBe(1);
    expect(r.details[0]?.reason).toBe('channel-not-listed');
    expect(await listDrafts({ runsDir: runs })).toEqual([]);
  });

  it('still drafts an outside send even when a profile claims allowlist-auto', async () => {
    sent.length = 0;
    const { outbox, runs } = fixture();
    reply(outbox, 'a.reply.eml', OUTSIDER);
    const r = await sendEmailOutbox({
      ...base(outbox, runs),
      profile: profile({ send: 'allowlist-auto', perMessageApproval: false, limitsTodo: false, recipients: { allow: [OUTSIDER], deny: [] } }),
    });
    // A portable allowlist can never prove verified self: best case is draft.
    expect(r.drafted).toBe(1);
    expect(sent).toEqual([]);
  });

  it('still sends to the allowlisted owner address — the trusted-recipient binding', async () => {
    sent.length = 0;
    const { outbox, runs } = fixture();
    reply(outbox, 'a.reply.eml', OWNER);
    const r = await sendEmailOutbox(base(outbox, runs));
    expect(r.sent).toBe(1);
    expect(sent.map(m => m.to)).toEqual([OWNER]);
    expect(readdirSync(join(outbox, 'sent'))).toEqual(['a.reply.eml']);
  });

  it('refuses an outside send as before when no drafts path is configured', async () => {
    sent.length = 0;
    const { outbox, runs } = fixture();
    reply(outbox, 'a.reply.eml', OUTSIDER);
    const { draftsRunsDir: _omit, ...opts } = base(outbox, runs);
    const r = await sendEmailOutbox(opts);
    expect(r.refused).toBe(1);
    expect(r.details[0]?.reason).toBe('recipient-not-allowed');
    expect(sent).toEqual([]);
  });
});
