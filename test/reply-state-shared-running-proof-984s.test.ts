import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readReplyState } from '../src/core/comms/reply-state.js';
import * as busEvidence from '../src/core/comms/work-item-bus-evidence.js';
import { appendBusInbox, type BusEnvelope } from '../src/core/fleet/bus-inbox.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';

let root = '';
afterEach(() => { vi.restoreAllMocks(); if (root) rmSync(root, { recursive: true, force: true }); });

it('carries recorded running proof on the canonical thread and drops it after expiry', () => {
  root = mkdtempSync(join(tmpdir(), 'reply-shared-proof-'));
  chmodSync(root, 0o700);
  let now = Date.parse('2026-11-14T12:30:00.000Z');
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const post = (id: string) => {
    const envelope: BusEnvelope = { id, from: 'fake-peer', to: 'fake-lane', priority: 'P2',
      ttl: 1_000_000, channel: 'slack', channel_ref: 'fake-thread',
      sender: { agent_id: 'fake-peer', vendor: 'fake-vendor', human: false, team: true },
      external: false, body: { kind: 'work' } };
    expect(appendBusInbox(envelope, { root, now: () => now }).status).toBe('posted');
  };
  post('fake-first');
  expect(mutateBusWorkClaim({ action: 'acquire', id: 'fake-first', owner: 'fake-owner',
    leaseMs: 60_000, root }).status).toBe('acquired');
  now += 1000;
  post('fake-repeat');
  const state = readReplyState('fake-repeat', { root, now });
  expect(state).toMatchObject({ state: 'RUNNING', id: 'fake-first', requestId: 'fake-repeat',
    duplicateOf: 'fake-first', owner: 'fake-owner', evidence: { running: expect.any(Object) } });
  expect(state.text).toContain(`owner fake-owner, claim ${state.claim}; running evidence: ${state.evidence.running?.source}, recorded at ${state.evidence.running?.at}; repeat of fake-first`);
  expect(state.text).toContain(`source: ${state.source}, evidence timestamp: ${state.asOf}`);
  now += 120_000;
  const expired = readReplyState('fake-repeat', { root, now });
  expect(expired.state).toBe('ASSIGNED');
  expect(expired.text).not.toContain('running evidence:');
});

it('normalizes and scrubs untrusted running evidence in shared text', () => {
  root = mkdtempSync(join(tmpdir(), 'reply-shared-proof-'));
  const original = busEvidence.deriveBusWorkItemEvidence;
  vi.spyOn(busEvidence, 'deriveBusWorkItemEvidence').mockImplementation((...args) => {
    const result = original(...args);
    result.evidence.owner = 'fake-owner';
    result.evidence.claimReceipt = 'fake-claim';
    result.evidence.runningEvidence = { source: 'fake\nsource\u001b[2J\u2028end', at: '2026-11-14T12:30:00.000Z' };
    return result;
  });
  const state = readReplyState('fake-work', { root, now: Date.parse('2026-11-14T12:30:00.000Z') });
  expect(state.state).toBe('RUNNING');
  expect(state.text).toContain('running evidence: fake source [2J end, recorded at 2026-11-14T12:30:00.000Z');
  expect(state.text.split('\n')).toHaveLength(2);
});
