import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readReplyState } from '../src/core/comms/reply-state.js';
import { appendBusInbox, type BusEnvelope } from '../src/core/fleet/bus-inbox.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';

let root: string, now: number;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'reply-verification-'));
  chmodSync(root, 0o700);
  now = Date.parse('2026-11-14T12:30:00.000Z');
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

function post(id: string) {
  const envelope: BusEnvelope = { id, from: 'fake-peer', to: 'fake-lane', priority: 'P2', ttl: 1_000_000,
    channel: 'slack', channel_ref: 'fake-thread',
    sender: { agent_id: 'fake-peer', vendor: 'fake-vendor', human: false, team: true },
    external: false, body: { kind: 'work' } };
  expect(appendBusInbox(envelope, { root, now: () => now }).status).toBe('posted');
  now += 1000;
}
function reply(verified: Record<string, unknown>) {
  expect(postBusReply('fake-first', 'fake-reply', { verified }, { root, now: () => now }).outcome).toBe('posted');
}

it('displays every proof on the canonical thread with its claim and provenance', () => {
  post('fake-first');
  expect(mutateBusWorkClaim({ action: 'acquire', id: 'fake-first', owner: 'fake-owner', leaseMs: 60_000, root }).status).toBe('acquired');
  post('fake-repeat');
  const proof = { pr: 7, head: 'fake-head', tests: 'fake tests passed', artifact: 'fake-report.txt' };
  reply(proof);
  const state = readReplyState('fake-repeat', { root, now });
  expect(state).toMatchObject({ state: 'VERIFIED', id: 'fake-first', requestId: 'fake-repeat', duplicateOf: 'fake-first', owner: 'fake-owner', evidence: { verified: proof } });
  expect(state.text).toContain(`owner fake-owner, claim ${state.claim}; PR ${proof.pr} at ${proof.head}; tests ${proof.tests}; artifact ${proof.artifact}; repeat of fake-first`);
  expect(state.text).toContain(`source: ${state.source}, evidence timestamp: ${state.asOf}`);
  expect(state.text.split('\n')).toHaveLength(2);
});

it.each([
  [{ tests: 'fake tests passed' }, 'tests fake tests passed'],
  [{ artifact: 'fake-report.txt' }, 'artifact fake-report.txt'],
])('displays a single available proof', (proof, text) => {
  post('fake-first');
  reply(proof);
  const state = readReplyState('fake-first', { root, now });
  expect(state.state).toBe('VERIFIED');
  expect(state.evidence.verified).toMatchObject(proof);
  expect(state.text.split('\n')[1]).toBe(text);
});

it('normalizes control characters in every untrusted verification string', () => {
  post('fake-first');
  const proof = { pr: 7, head: 'fake\nhead', tests: 'fake\u001btests', artifact: 'fake\u2028report' };
  reply(proof);
  const state = readReplyState('fake-first', { root, now });
  expect(state.evidence.verified).toMatchObject(proof);
  expect(state.text.split('\n')).toHaveLength(2);
  expect(state.text).toContain('PR 7 at fake head; tests fake tests; artifact fake report');
});
