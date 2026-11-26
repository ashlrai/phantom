import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';
import { collectBusWorkItemEvidence } from '../src/core/comms/work-item-bus-evidence.js';
import { readReplyState } from '../src/core/comms/reply-state.js';
import { listWorkBoard } from '../src/core/comms/work-board.js';

let root: string, now: number;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'claim-truth-'));
  chmodSync(root, 0o700);
  now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

function request(id: string) {
  expect(appendBusInbox({ id, from: 'fake-peer', to: 'fake-lane', priority: 'P2',
    ttl: 10_000_000, body: { kind: 'work' } }, { root, now: () => now }).status).toBe('posted');
}
function claim(id: string) {
  const result = mutateBusWorkClaim({ action: 'acquire', id, owner: 'fake-owner', leaseMs: 600_000, root });
  expect(result.status).toBe('acquired');
  return result;
}
function checkAssigned(id: string, at: number, receivedAt: number) {
  const collected = collectBusWorkItemEvidence(id, { root, now: at }).evidence;
  const reply = readReplyState(id, { root, now: at });
  const item = listWorkBoard({ root, now: at }).items.find(row => row.id === id);
  expect(collected.runningEvidence).toBeUndefined();
  expect(reply).toMatchObject({ state: 'ASSIGNED', owner: 'fake-owner', evidence: { running: null },
    asOf: new Date(receivedAt).toISOString() });
  expect(reply.claim).toMatch(new RegExp(`^bus-claim:${id}:`));
  expect(item).toMatchObject({ state: reply.state, owner: reply.owner, claimReceipt: reply.claim,
    asOf: reply.asOf, source: reply.source });
}

describe('coordination claims are not execution evidence', () => {
  it('keeps a live and then expired claim assigned across repeated reads', () => {
    const receivedAt = now;
    request('fake-live');
    claim('fake-live');
    expect(postBusReply('fake-live', 'fake-prose', { text: 'running now' },
      { root, now: () => now }).outcome).toBe('posted');
    for (const delta of [0, 300_000, 600_000, 2_500_000]) checkAssigned('fake-live', now + delta, receivedAt);
  });

  it('preserves ownership after completion without inventing execution', () => {
    const receivedAt = now;
    request('fake-complete');
    const acquired = claim('fake-complete');
    expect(mutateBusWorkClaim({ action: 'complete', id: 'fake-complete', token: acquired.token, root }).status).toBe('completed');
    checkAssigned('fake-complete', now, receivedAt);
    checkAssigned('fake-complete', now + 2_500_000, receivedAt);
  });

  it.each([
    ['fake-blocked', { blocked: { dependency: 'fake dependency' } }, 'BLOCKED', { kind: 'blocked', dependency: 'fake dependency' }],
    ['fake-verified', { verified: { pr: 7, head: 'fake-head' } }, 'VERIFIED',
      { kind: 'verified', pr: 7, head: 'fake-head', tests: null, artifact: null }],
  ])('retains structured proof for %s', (id, body, state, result) => {
    request(id);
    claim(id);
    now += 1_000;
    expect(postBusReply(id, `${id}-reply`, body, { root, now: () => now }).outcome).toBe('posted');
    expect(readReplyState(id, { root, now }).state).toBe(state);
    expect(listWorkBoard({ root, now }).items.find(row => row.id === id)).toMatchObject({ state, result });
  });
});
