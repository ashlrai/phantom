/**
 * `readFleetCoordinationPending` — the fleet-wide pending projection over
 * the advisory `fleet.coordination.v1` ledger: live messages, live
 * assignment proposals and unpublished RESULT intents in one atomic read.
 * Hermetic: every ledger lives under a temp dir via `options.path`.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  claimFleetWork, concludeFleetClaim, postFleetMessage, proposeFleetAssignment,
  readFleetBoard, readFleetCoordinationPending,
} from '../src/core/fleet/coordination.js';

const T0 = 1_760_000_000_000;
const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'coordination-pending-'));
  dirs.push(dir);
  return { path: join(dir, 'coordination.jsonl'), now: T0 };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A claim concluded `intended` whose receipt publish never ran — the
 * `released-unposted` class: the return event is durable, no `post` event
 * exists, and the board read cannot name it. */
function pendingReturn(options: { path: string; now: number }, agent = 'agent-d') {
  const claim = claimFleetWork({ repo: 'ashlrai/phantom', task: 'claimed work', agent }, options);
  if (!claim.ok) throw new Error('fixture claim failed');
  const id = claim.value.claim.id;
  const concluded = concludeFleetClaim({
    id, agent, lease: claim.value.lease,
    message: { id: `return-${id}`, from: agent, to: 'all',
      body: `RESULT VERIFIED ashlrai/phantom claim ${id} task "claimed work": tests passed`, ttlMs: 86_400_000 },
  }, options);
  if (!concluded.ok || concluded.value.outcome !== 'intended') throw new Error('fixture return failed');
  return { claimId: id, agent };
}

describe('readFleetCoordinationPending', () => {
  it('reports a verified-absent ledger as missing, never an invented backlog', () => {
    const { path, now } = fixture();
    expect(readFleetCoordinationPending({ path, now }))
      .toEqual({ schema: 'fleet.coordination.v1', state: 'missing', messages: [], proposals: [], returns: [] });
  });

  it('projects live messages, proposals and unpublished returns atomically', () => {
    const { path, now } = fixture();
    const options = { path, now };
    postFleetMessage({ from: 'agent-a', to: 'agent-b', body: 'ping agent-b', ttlMs: 3_600_000 }, options);
    postFleetMessage({ from: 'agent-a', to: 'all', body: 'broadcast note', ttlMs: 3_600_000 }, options);
    proposeFleetAssignment({ repo: 'ashlrai/phantom', task: 'do the thing', to: 'agent-c', ttlMs: 3_600_000 }, options);
    const ret = pendingReturn(options);

    const pending = readFleetCoordinationPending(options);
    expect(pending.state).toBe('known');
    expect(pending.messages.map(m => `${m.from}>${m.to}:${m.body}`))
      .toEqual(['agent-a>agent-b:ping agent-b', 'agent-a>all:broadcast note']);
    expect(pending.proposals).toHaveLength(1);
    expect(pending.proposals[0]).toMatchObject({ repo: 'ashlrai/phantom', task: 'do the thing', to: 'agent-c', executionAuthorized: false });
    expect(pending.returns).toHaveLength(1);
    expect(pending.returns[0]).toMatchObject({ id: ret.claimId, agent: ret.agent, at: now });
    expect(pending.returns[0]!.message).toMatchObject({ id: `return-${ret.claimId}`, to: 'all', expiresAt: now + 86_400_000 });

    // The message/proposal projection is the board's own — the two reads can
    // never disagree about what is live.
    const board = readFleetBoard({ ...options, reap: false });
    expect(pending.messages).toEqual(board.messages);
    expect(pending.proposals).toEqual(board.proposals);
    // The board read itself still cannot name the orphaned intent.
    expect(board.messages.some(m => m.id === `return-${ret.claimId}`)).toBe(false);
  });

  it('never carries lease material or the retained owner claim', () => {
    const { path, now } = fixture();
    const options = { path, now };
    const ret = pendingReturn(options);
    const pending = readFleetCoordinationPending(options);
    const serialized = JSON.stringify(pending);
    expect(serialized).not.toContain('leaseHash');
    expect(serialized).not.toContain('"claim"');
    // The lease itself is random per claim; the projection shape must not
    // grow a field that could carry it.
    expect(Object.keys(pending.returns[0]!).sort()).toEqual(['agent', 'at', 'id', 'message']);
    expect(ret.claimId).toBeTruthy();
  });

  it('drops expired messages, proposals and dead return intents', () => {
    const { path, now } = fixture();
    const options = { path, now };
    postFleetMessage({ from: 'agent-a', to: 'agent-b', body: 'short lived', ttlMs: 1_000 }, options);
    proposeFleetAssignment({ repo: 'ashlrai/phantom', task: 'brief offer', to: 'agent-c', ttlMs: 1_000 }, options);
    const claim = claimFleetWork({ repo: 'ashlrai/phantom', task: 'claimed work', agent: 'agent-d' }, options);
    if (!claim.ok) throw new Error('fixture claim failed');
    concludeFleetClaim({
      id: claim.value.claim.id, agent: 'agent-d', lease: claim.value.lease,
      message: { id: `return-${claim.value.claim.id}`, from: 'agent-d', to: 'all',
        body: 'RESULT VERIFIED ashlrai/phantom claim x task "y": tests passed', ttlMs: 1_000 },
    }, options);
    const later = readFleetCoordinationPending({ path, now: now + 2_000 });
    expect(later.state).toBe('known');
    expect(later.messages).toEqual([]);
    expect(later.proposals).toEqual([]);
    expect(later.returns).toEqual([]);
  });

  it('reports an unreadable or malformed ledger as unknown, never an empty backlog', () => {
    const { path, now } = fixture();
    writeFileSync(path, 'this is not jsonl\n', { mode: 0o600 });
    expect(readFleetCoordinationPending({ path, now }))
      .toEqual({ schema: 'fleet.coordination.v1', state: 'unknown', messages: [], proposals: [], returns: [] });
    // A torn tail fails the same way.
    writeFileSync(path, '{"version":1,"kind":"post","at":1,"message":{"id":"m"}}\n', { mode: 0o600 });
    expect(readFleetCoordinationPending({ path, now }).state).toBe('unknown');
  });
});
