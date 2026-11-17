import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSlackWorkStatus, slackWorkStatusLine, type SlackWorkStatus } from '../src/core/agents/slack-status.js';
import { appendBusInbox, type BusEnvelope } from '../src/core/fleet/bus-inbox.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';

const hash = (id: string) => createHash('sha256').update(JSON.stringify(['slack', id])).digest('hex');
const a: SlackWorkStatus['items'][number] = { id: 'fake-a', channelRef: 'fake-thread', state: 'VERIFIED', owner: 'fake-owner-a', claimReceipt: 'fake-claim-a', pr: 42, head: 'abcdef123', dependency: 'fake-blocker-a' };
const b: SlackWorkStatus['items'][number] = { ...a, id: 'fake-b', state: 'ASSIGNED', owner: 'fake-owner-b', claimReceipt: 'fake-claim-b', pr: 43, head: 'abcdef456', dependency: 'fake-blocker-b' };
const status = (items: SlackWorkStatus['items']): SlackWorkStatus => ({ asOf: null, inbox: 'ok', truncated: false, items });
const unknown = 'UNKNOWN; owner unknown; claim unknown; fleet as of unknown';

describe('Slack work identity', () => {
  it.each([[a, b], [b, a]])('rejects conflicting aliases regardless of row order', (first, second) => {
    const work = status([first, second]);
    expect(slackWorkStatusLine(work, { inReplyTo: a.id, in_reply_to: b.id })).toBe(unknown);
    expect(slackWorkStatusLine(work, { inReplyTo: a.id, requestId: hash(b.id) })).toBe(unknown);
    expect(slackWorkStatusLine(work, { inReplyTo: a.id, in_reply_to: 'fake-missing' })).toBe(unknown);
    expect(slackWorkStatusLine(work, { inReplyTo: a.id, requestId: hash('fake-missing') })).toBe(unknown);
  });
  it('accepts consistent and lone aliases, ignoring thread metadata', () => {
    const work = status([a, b]);
    const expected = 'VERIFIED; PR 42; head abcdef123; fleet as of unknown';
    for (const body of [{ inReplyTo: a.id }, { in_reply_to: a.id }, { requestId: hash(a.id) },
      { inReplyTo: a.id, in_reply_to: a.id, requestId: hash(a.id), thread: 'other-thread' }]) {
      expect(slackWorkStatusLine(work, body)).toBe(expected);
    }
    expect(slackWorkStatusLine(work, { thread: a.id })).toBe(unknown);
  });
  it('rejects duplicate matching rows without exposing their evidence', () => {
    expect(slackWorkStatusLine(status([a, { ...b, id: a.id }]), { inReplyTo: a.id })).toBe(unknown);
    expect(slackWorkStatusLine(status([a, { ...b, id: a.id }]), { requestId: hash(a.id) })).toBe(unknown);
  });
  it('rejects conflicting aliases against the receipt-backed disk board', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slack-identity-500s-'));
    try {
      const root = join(dir, 'bus'), now = Date.now(), channelRef = 'slack:T0TEST:C0TESTCHAN1:1700000000.000100';
      const request = (id: string): BusEnvelope => ({ id, from: 'fake-owner', to: 'leader', priority: 'P1', ttl: 600_000,
        channel: 'slack', channel_ref: channelRef, external: false,
        sender: { agent_id: 'fake-owner', vendor: 'fake', human: true, team: true }, body: { kind: 'note', text: 'status' } });
      for (const id of [a.id, b.id]) expect(appendBusInbox(request(id), { root, now: () => now }).status).toBe('posted');
      const claim = mutateBusWorkClaim({ action: 'acquire', root, id: b.id, owner: 'fake-worker', leaseMs: 60_000 });
      expect(claim.status).toBe('acquired');
      expect(mutateBusWorkClaim({ action: 'complete', root, id: b.id, token: claim.token }).status).toBe('completed');
      expect(postBusReply(a.id, 'fake-reply', { verified: { pr: 42, head: 'abcdef123' } }, { root, now: () => now }).outcome).toBe('posted');
      const work = readSlackWorkStatus({ busRoot: root, runsDir: dir, channelRef, now: () => new Date(now) });
      expect(work.items.find(item => item.id === a.id)?.state).toBe('VERIFIED');
      expect(work.items.find(item => item.id === b.id)?.state).toBe('ASSIGNED');
      expect(slackWorkStatusLine(work, { inReplyTo: a.id, requestId: hash(b.id) })).toBe(unknown);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
