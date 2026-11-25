import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readReplyState, REPLY_STATE_SCHEMA } from '../src/core/comms/reply-state.js';
import { appendBusInbox, type BusEnvelope } from '../src/core/fleet/bus-inbox.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';

let root: string;
let now: number;
const post = (id: string) => {
  const envelope: BusEnvelope = {
    id, from: 'fake-peer', to: 'fake-lane', priority: 'P2', ttl: 10_000_000,
    channel: 'slack', channel_ref: 'fake-thread',
    sender: { agent_id: 'fake-peer', vendor: 'fake-vendor', human: false, team: true },
    external: false, body: { kind: 'work' },
  };
  expect(appendBusInbox(envelope, { root, now: () => now }).status).toBe('posted');
  now += 1000;
};
const claim = (id: string) => expect(mutateBusWorkClaim({
  action: 'acquire', id, owner: 'fake-owner', leaseMs: 600_000, root,
}).status).toBe('acquired');
const reply = (id: string, body: Record<string, unknown>) =>
  expect(postBusReply(id, `reply-${id}`, body, { root, now: () => now }).outcome).toBe('posted');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'reply-owner-'));
  chmodSync(root, 0o700);
  now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('reply state text assignment', { timeout: 60_000 }, () => {
  it('retains the owner, durable claim and dependency for a repeated blocked request', () => {
    post('fake-first');
    claim('fake-first');
    reply('fake-first', { blocked: { dependency: 'fake dependency' } });
    post('fake-repeat');
    const state = readReplyState('fake-repeat', { root, now });
    expect(state).toMatchObject({ schema: REPLY_STATE_SCHEMA, id: 'fake-first', requestId: 'fake-repeat',
      duplicateOf: 'fake-first', state: 'BLOCKED', owner: 'fake-owner',
      claim: expect.stringContaining('bus-claim:fake-first'), evidence: { blocked: { dependency: 'fake dependency' } } });
    expect(state.text).toContain(`owner fake-owner, claim ${state.claim}; waiting on fake dependency; repeat of fake-first`);
  });

  it('retains assignment and PR/head proof for verified work', () => {
    post('fake-verified');
    claim('fake-verified');
    reply('fake-verified', { verified: { pr: 7, head: 'fakehead' } });
    const state = readReplyState('fake-verified', { root, now });
    expect(state).toMatchObject({ state: 'VERIFIED', owner: 'fake-owner',
      claim: expect.stringContaining('bus-claim:fake-verified'),
      evidence: { verified: { pr: 7, head: 'fakehead', tests: null, artifact: null } } });
    expect(state.text).toContain(`owner fake-owner, claim ${state.claim}; PR 7 at fakehead`);
  });

  it.each([
    ['BLOCKED', { blocked: { dependency: 'fake dependency' } }, 'waiting on fake dependency'],
    ['VERIFIED', { verified: { pr: 7, head: 'fakehead' } }, 'PR 7 at fakehead'],
  ])('does not fabricate assignment for ownerless %s', (expected, body, proof) => {
    post('fake-ownerless');
    reply('fake-ownerless', body);
    const state = readReplyState('fake-ownerless', { root, now });
    expect(state).toMatchObject({ state: expected, owner: null, claim: null });
    expect(state.text.split('\n')[1]).toBe(proof);
  });
});
