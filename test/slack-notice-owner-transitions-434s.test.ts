import { describe, expect, it } from 'vitest';
import { runClaimNoticePass, type ClaimNoticePassResult, type ClaimNoticeSendDeps } from '../src/core/fleet/claim-notice-send.js';
import type { ClaimThreadBinding, ClaimThreadSnapshot } from '../src/core/fleet/claim-thread-notice.js';
import type { FleetBoard, FleetClaim, FleetMessage } from '../src/core/fleet/coordination.js';

const t0 = Date.parse('2026-11-15T12:00:00Z');
const TTL = 3_600_000;

const claim = (over: Partial<FleetClaim>): FleetClaim => ({
  id: 'claim-x', repo: 'fake/repo', task: 'fake task', agent: 'agent-a',
  claimedAt: t0 - 10, expiresAt: t0 - 10 + TTL, ...over,
});
const receipt = (repo: string, at: number, head = 'abcdef1234567'): FleetMessage => ({
  id: 'return-claim-x', from: 'agent-a', to: 'all', at, expiresAt: at + 60_000,
  body: `RESULT VERIFIED ${repo} claim claim-x task "fake task": pr #7 head ${head}`,
});

interface Harness {
  deps: ClaimNoticeSendDeps;
  sends: { threadKey: string; text: string; dedupeKey: string }[];
  sent: Set<string>;
  setBoard: (claims: FleetClaim[], messages?: FleetMessage[], state?: FleetBoard['state']) => void;
  tick: () => Promise<unknown>;
}

function harness(bindings: ClaimThreadBinding[], start: FleetClaim[] = []): Harness {
  let clock = t0;
  let board: FleetBoard = { schema: 'fleet.coordination.v1', state: 'known',
    claims: start, messages: [], proposals: [], expiredClaims: 0 };
  let snapshot: ClaimThreadSnapshot | null =
    { state: 'known', claims: [], messages: [], asOf: t0 - 60_000 };
  const sent = new Set<string>();
  const sends: Harness['sends'] = [];
  const deps: ClaimNoticeSendDeps = {
    readBoard: () => board,
    readPrevSnapshot: () => snapshot,
    writePrevSnapshot: value => { snapshot = value; },
    readBindings: () => bindings,
    readSentLedger: () => sent,
    appendSentLedger: key => { sent.add(key); },
    send: (threadKey, text, dedupeKey) => {
      sends.push({ threadKey, text, dedupeKey });
      return { ok: true, receipt: 'fake-receipt' };
    },
    now: () => clock,
  };
  return {
    deps, sends, sent,
    setBoard: (claims, messages = board.messages, state = 'known') => {
      board = { schema: 'fleet.coordination.v1', state, claims, messages,
        proposals: [], expiredClaims: 0 };
    },
    tick: async () => { clock += 1_000; return runClaimNoticePass(deps); },
  };
}

const threadA = 'T000FAKE/C000FAKE/1700000000.000001';
const threadB = 'T000FAKE/C000FAKE/1700000000.000002';

describe('claim notice owner transitions (RQ-PHX-SLACKNOTICEIDENTITY434S)', () => {
  it('A -> B -> A on one claim id posts each acquisition to its thread exactly once', async () => {
    const h = harness([{ claimId: 'claim-x', repo: 'fake/repo', threadKey: threadA, pr: 7,
      head: 'abcdef1234567' }], [claim({ agent: 'agent-a' })]);
    // First acquisition.
    expect(await h.tick()).toMatchObject({ status: 'completed', sent: 1 });
    // Handoff to agent-b: same claim id and head, fresh claimedAt.
    h.setBoard([claim({ agent: 'agent-b', claimedAt: t0 + 990, expiresAt: t0 + 990 + TTL })]);
    expect(await h.tick()).toMatchObject({ status: 'completed', sent: 1 });
    // Handoff back to agent-a: another fresh claimedAt.
    h.setBoard([claim({ agent: 'agent-a', claimedAt: t0 + 1_990, expiresAt: t0 + 1_990 + TTL })]);
    expect(await h.tick()).toMatchObject({ status: 'completed', sent: 1 });
    expect(h.sends).toHaveLength(3);
    expect(h.sends.every(s => s.threadKey === threadA && s.text.includes('ASSIGNED'))).toBe(true);
    expect(h.sends.map(s => s.text).join('\n')).toContain('agent-a');
    expect(h.sends.map(s => s.text).join('\n')).toContain('agent-b');
    // Every real acquisition earned its own durable identity.
    const keys = h.sends.map(s => s.dedupeKey);
    expect(new Set(keys).size).toBe(3);
    // Unchanged replay sends nothing and plans nothing.
    const replay = await h.tick() as ClaimNoticePassResult;
    expect(replay).toMatchObject({ status: 'completed', planned: 0, sent: 0 });
    expect(h.sends).toHaveLength(3);
    expect(h.sent.size).toBe(3);
  });

  it('the same claim id in two repositories routes and returns independently', async () => {
    const bindings: ClaimThreadBinding[] = [
      { claimId: 'claim-x', repo: 'fake/repo', threadKey: threadA, pr: 7, head: 'abcdef1234567' },
      { claimId: 'claim-x', repo: 'other/repo', threadKey: threadB, pr: 9, head: '1234567abcdef' },
    ];
    const h = harness(bindings, [
      claim({ agent: 'agent-a' }),
      claim({ repo: 'other/repo', agent: 'agent-c' }),
    ]);
    expect(await h.tick()).toMatchObject({ status: 'completed', sent: 2 });
    expect(h.sends.map(s => s.threadKey).sort()).toEqual([threadA, threadB].sort());
    expect(new Set(h.sends.map(s => s.dedupeKey)).size).toBe(2);
    // A VERIFIED receipt in fake/repo only: repo1 hears it, repo2 does not.
    h.setBoard([claim({ agent: 'agent-a' }), claim({ repo: 'other/repo', agent: 'agent-c' })],
      [receipt('fake/repo', t0 + 1_500)]);
    expect(await h.tick()).toMatchObject({ status: 'completed', sent: 1 });
    expect(h.sends.at(-1)).toMatchObject({ threadKey: threadA });
    expect(h.sends.at(-1)!.text).toContain('VERIFIED');
    // repo2's claim disappears while only repo1's receipt exists: the receipt
    // must not suppress repo2's RELEASED, and repo2 routes to its own thread.
    h.setBoard([claim({ agent: 'agent-a' })], [receipt('fake/repo', t0 + 1_500)]);
    expect(await h.tick()).toMatchObject({ status: 'completed', sent: 1 });
    expect(h.sends.at(-1)).toMatchObject({ threadKey: threadB });
    expect(h.sends.at(-1)!.text).toContain('RELEASED');
    // repo2's own receipt is new evidence, not fenced by repo1's receipt.
    h.setBoard([claim({ agent: 'agent-a' })],
      [receipt('fake/repo', t0 + 1_500), receipt('other/repo', t0 + 2_500, '1234567abcdef')]);
    expect(await h.tick()).toMatchObject({ status: 'completed', sent: 1 });
    expect(h.sends.at(-1)).toMatchObject({ threadKey: threadB });
    expect(h.sends.at(-1)!.text).toContain('VERIFIED');
    // Steady state: nothing further is planned or sent.
    const quiet = await h.tick() as ClaimNoticePassResult;
    expect(quiet).toMatchObject({ status: 'completed', planned: 0, sent: 0 });
    expect(h.sends).toHaveLength(5);
  });

  it('an unknown board read sends nothing and writes no snapshot', async () => {
    const h = harness([{ claimId: 'claim-x', repo: 'fake/repo', threadKey: threadA }],
      [claim({ agent: 'agent-a' })]);
    h.setBoard([claim({ agent: 'agent-a' })], [], 'unknown');
    const result = await h.tick() as ClaimNoticePassResult;
    expect(result).toMatchObject({ status: 'board-unavailable', sent: 0 });
    expect(h.sends).toHaveLength(0);
    expect(h.sent.size).toBe(0);
  });
});
