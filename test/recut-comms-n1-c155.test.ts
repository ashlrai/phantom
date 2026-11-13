/**
 * RQ-PHX-RECUTCOMMSN1C155 — recut of #4675 (RQ-PHX-RECUTR3600S73, itself a
 * recut of #3608). The payload already landed on master: portable agent
 * profiles (src/core/agents/agent-profile.ts), the fail-closed send policy
 * (src/core/agents/send-policy.ts) and the allowlist/draft email outbox
 * (src/core/comms/email-outbox.ts). This suite pins the comms invariants
 * through the real modules: an outside-person send never leaves the machine
 * as a send — it is drafted for owner approval or refused.
 */
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateAgentProfile } from '../src/core/agents/agent-profile.js';
import { checkSend } from '../src/core/agents/send-policy.js';
import { readEmailOutbox, sendEmailOutbox, type EmailOutboxMessage } from '../src/core/comms/email-outbox.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const OUTSIDER = 'someone@example.invalid';
const OWNER = 'operator@example.invalid';

function outbox(): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), 'recut-c155-'));
  roots.push(root);
  const dir = join(root, 'outbox');
  mkdirSync(dir, { recursive: true });
  return { root, dir };
}

const writeReply = (dir: string, name: string, to: string, body = 'ack body'): void =>
  writeFileSync(join(dir, name), `To: ${to}\r\nSubject: Re: status\r\n\r\n${body}\r\n`);

describe('recut-comms-n1-c155: landed send policy', () => {
  it('an unproven profile can only ever draft an outside-person send', () => {
    const profile = validateAgentProfile({
      id: 'helper',
      displayName: 'Helper',
      doctrine: 'doctrine.md',
      channels: ['email'],
      policy: { send: 'allowlist-auto', perMessageApproval: false, recipients: { allow: [OUTSIDER], deny: [] } },
    });
    // limitsTodo defaults true: even an allowlisted recipient stays a draft.
    expect(checkSend(profile, 'email', OUTSIDER, 0)).toEqual({ decision: 'draft', reason: 'limits-incomplete' });
    // And a portable allowlist never proves verified-self: limits done still drafts.
    const settled = structuredClone(profile);
    settled.policy.limitsTodo = false;
    expect(checkSend(settled, 'email', OUTSIDER, 0).decision).toBe('draft');
  });

  it('a denied recipient is refused outright even when also allowlisted', () => {
    const profile = validateAgentProfile({
      id: 'helper',
      displayName: 'Helper',
      doctrine: 'doctrine.md',
      channels: ['email'],
      policy: { send: 'allowlist-auto', perMessageApproval: false, recipients: { allow: [OUTSIDER], deny: [OUTSIDER] } },
    });
    expect(checkSend(profile, 'email', OUTSIDER, 0).decision).toBe('deny');
  });
});

describe('recut-comms-n1-c155: email outbox keeps outside sends local', () => {
  it('an outside-person send is still a draft — the transport is never called', async () => {
    const { root, dir } = outbox();
    writeReply(dir, 'outside.reply.eml', OUTSIDER);
    const transport = vi.fn(async (_message: EmailOutboxMessage) => ({ ok: true }));
    const result = await sendEmailOutbox({
      dir,
      allowedRecipients: new Set([OWNER]),
      transport,
      draftsRunsDir: root,
    });
    expect(result.sent).toBe(0);
    expect(result.drafted).toBe(1);
    expect(transport).not.toHaveBeenCalled();
    const detail = result.details.find((entry) => entry.name === 'outside.reply.eml')!;
    expect(detail.outcome).toBe('drafted');
    expect(detail.to).toBe(OUTSIDER);
    expect(detail.draftId).toBeTruthy();
    // The reply file moved to drafted/ and the draft is pending in the runs dir.
    expect(readdirSync(join(dir, 'drafted'))).toEqual(['outside.reply.eml']);
    const stored = readFileSync(join(root, 'drafts', 'drafts.jsonl'), 'utf8');
    expect(JSON.parse(stored).status).toBe('pending');
    expect(readEmailOutbox(dir).counts).toEqual({ queued: 0, sent: 0, stuck: 0, drafted: 1 });
  });

  it('without a drafts runs dir an outside send is refused and stays queued', async () => {
    const { dir } = outbox();
    writeReply(dir, 'outside.reply.eml', OUTSIDER);
    const transport = vi.fn(async (_message: EmailOutboxMessage) => ({ ok: true }));
    const result = await sendEmailOutbox({ dir, allowedRecipients: new Set([OWNER]), transport });
    expect(result).toMatchObject({ sent: 0, drafted: 0, refused: 1 });
    expect(transport).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toContain('outside.reply.eml');
  });

  it('an allowlisted owner reply still sends exactly once', async () => {
    const { dir } = outbox();
    writeReply(dir, 'owner.reply.eml', OWNER);
    const calls: EmailOutboxMessage[] = [];
    const result = await sendEmailOutbox({
      dir,
      allowedRecipients: new Set([OWNER]),
      transport: async (message) => { calls.push(message); return { ok: true }; },
    });
    expect(result).toMatchObject({ sent: 1, drafted: 0, refused: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.to).toBe(OWNER);
  });
});
