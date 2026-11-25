import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { readReplyState } from '../src/core/comms/reply-state.js';
import { appendBusInbox, type BusEnvelope } from '../src/core/fleet/bus-inbox.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';

it('partitions same-thread requests by exact recipient and retains arrival order', () => {
  const root = mkdtempSync(join(tmpdir(), 'reply-recipient-'));
  chmodSync(root, 0o700);
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const post = (id: string, to: string) => {
    const envelope: BusEnvelope = {
      id, from: 'fake-peer', to, priority: 'P2', ttl: 10_000_000,
      channel: 'slack', channel_ref: 'fake-thread',
      sender: { agent_id: 'fake-peer', vendor: 'fake-vendor', human: false, team: true },
      external: false, body: { kind: 'work' },
    };
    expect(appendBusInbox(envelope, { root, now: () => now }).status).toBe('posted');
    now += 1_000;
  };
  const read = (id: string) => readReplyState(id, { root, now });
  try {
    post('fake-first', 'fake-agent-a');
    expect(mutateBusWorkClaim({ action: 'acquire', id: 'fake-first', owner: 'fake-owner', leaseMs: 600_000, root }).status).toBe('acquired');
    post('fake-second', 'fake-agent-b');
    expect(read('fake-first')).toMatchObject({ state: 'RUNNING', owner: 'fake-owner' });
    expect(read('fake-second')).toMatchObject({ requestId: 'fake-second', id: 'fake-second', duplicateOf: null,
      state: 'RECEIVED', owner: null, claim: null, evidence: { running: null, blocked: null, verified: null } });
    post('fake-second-repeat', 'fake-agent-b');
    post('fake-first-repeat', 'fake-agent-a');
    expect(read('fake-second-repeat')).toMatchObject({ requestId: 'fake-second-repeat', id: 'fake-second', duplicateOf: 'fake-second',
      state: 'RECEIVED', owner: null, claim: null, evidence: { running: null, blocked: null, verified: null } });
    expect(read('fake-first-repeat')).toMatchObject({ requestId: 'fake-first-repeat', id: 'fake-first', duplicateOf: 'fake-first',
      state: 'RUNNING', owner: 'fake-owner' });
  } finally {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
