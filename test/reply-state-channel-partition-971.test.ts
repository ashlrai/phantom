import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readReplyState } from '../src/core/comms/reply-state.js';
import { appendBusInbox, type BusEnvelope } from '../src/core/fleet/bus-inbox.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';

let root: string;
let now: number;
const ref = 'fake-shared-thread';
const post = (id: string, channel?: 'slack' | 'imessage' | 'bus') => {
  const envelope: BusEnvelope = {
    id, from: 'fake-peer', to: 'fake-lane', priority: 'P2', ttl: 10_000_000, body: { kind: 'work' },
    ...(channel ? { channel, channel_ref: ref,
      sender: { agent_id: 'fake-peer', vendor: 'fake-vendor', human: false, team: true }, external: false } : {}),
  };
  expect(appendBusInbox(envelope, { root, now: () => now }).status).toBe('posted');
  now += 1_000;
};
const read = (id: string) => readReplyState(id, { root, now });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'reply-channel-'));
  chmodSync(root, 0o700);
  now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('reply-state channel partition', { timeout: 60_000 }, () => {
  it.each([['imessage', 'slack'], ['slack', 'imessage']] as const)(
    'keeps a later %s / %s request independent', (first, second) => {
      post('fake-first', first);
      expect(mutateBusWorkClaim({ action: 'acquire', id: 'fake-first', owner: 'fake-owner', leaseMs: 600_000, root }).status).toBe('acquired');
      post('fake-second', second);
      expect(read('fake-first')).toMatchObject({ id: 'fake-first', state: 'RUNNING', owner: 'fake-owner' });
      expect(read('fake-second')).toMatchObject({ id: 'fake-second', duplicateOf: null, state: 'RECEIVED', owner: null, claim: null,
        evidence: { running: null, blocked: null, verified: null } });
    },
  );

  it('still resolves a same-channel repeat to its first request', () => {
    post('fake-first', 'slack');
    post('fake-other', 'imessage');
    post('fake-repeat', 'slack');
    expect(read('fake-repeat')).toMatchObject({ id: 'fake-first', duplicateOf: 'fake-first' });
  });

  it('keeps legacy bus messages without a reference independent of explicit bus threads', () => {
    post('fake-legacy');
    post('fake-bus', 'bus');
    post('fake-bus-repeat', 'bus');
    expect(read('fake-legacy')).toMatchObject({ id: 'fake-legacy', duplicateOf: null });
    expect(read('fake-bus-repeat')).toMatchObject({ id: 'fake-bus', duplicateOf: 'fake-bus' });
  });
});
