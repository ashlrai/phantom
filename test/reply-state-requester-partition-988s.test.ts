import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { readReplyState } from '../src/core/comms/reply-state.js';
import { appendBusInbox, type BusEnvelope } from '../src/core/fleet/bus-inbox.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';

it('partitions same-thread requests by exact requester and retains arrival order across clock rollback', () => {
  const root = mkdtempSync(join(tmpdir(), 'reply-requester-'));
  chmodSync(root, 0o700);
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const post = (id: string, from: string) => {
    const envelope: BusEnvelope = {
      id, from, to: 'fake-worker', priority: 'P2', ttl: 10_000_000,
      channel: 'slack', channel_ref: 'fake-thread',
      sender: { agent_id: from, vendor: 'fake-vendor', human: false, team: true },
      external: false, body: { kind: 'work' },
    };
    expect(appendBusInbox(envelope, { root, now: () => now }).status).toBe('posted');
    now += 1_000;
  };
  const read = (id: string) => readReplyState(id, { root, now });
  try {
    post('fake-a-first', 'fake-agent-a');
    expect(mutateBusWorkClaim({ action: 'acquire', id: 'fake-a-first', owner: 'fake-owner', leaseMs: 600_000, root }).status).toBe('acquired');
    post('fake-b-first', 'fake-agent-b');
    expect(read('fake-a-first')).toMatchObject({ state: 'RUNNING', owner: 'fake-owner' });
    const b = read('fake-b-first');
    expect(b).toMatchObject({ requestId: 'fake-b-first', id: 'fake-b-first', duplicateOf: null,
      state: 'RECEIVED', owner: null, claim: null, evidence: { running: null, blocked: null, verified: null } });
    expect(b.text).not.toContain('fake-owner');
    expect(b.text).toContain('no owner yet');
    now -= 3_000;
    post('fake-b-repeat', 'fake-agent-b');
    post('fake-a-repeat', 'fake-agent-a');
    expect(read('fake-b-repeat')).toMatchObject({ requestId: 'fake-b-repeat', id: 'fake-b-first', duplicateOf: 'fake-b-first',
      state: 'RECEIVED', owner: null, claim: null, evidence: { running: null, blocked: null, verified: null } });
    expect(read('fake-a-repeat')).toMatchObject({ requestId: 'fake-a-repeat', id: 'fake-a-first', duplicateOf: 'fake-a-first',
      state: 'RUNNING', owner: 'fake-owner' });
  } finally {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
