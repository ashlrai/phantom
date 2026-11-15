import { describe, expect, it } from 'vitest';
import { createClaimNoticeTick } from '../src/cli/channels-slack-claim-tick.js';
import { runClaimNoticePass, type ClaimNoticeSendDeps } from '../src/core/fleet/claim-notice-send.js';
import type { ClaimThreadSnapshot } from '../src/core/fleet/claim-thread-notice.js';
import type { FleetBoard } from '../src/core/fleet/coordination.js';

const now = 1_000_000;
const claim = { id: 'fake-claim', repo: 'fake/repo', task: 'fake task', agent: 'fake-agent',
  claimedAt: now - 1_000, expiresAt: now + 100_000 };

function harness() {
  let clock = now;
  let boardState: FleetBoard['state'] = 'known';
  let readable = true;
  let snapshot: ClaimThreadSnapshot = { state: 'known', claims: [], messages: [], asOf: now - 1 };
  const writes: ClaimThreadSnapshot[] = [];
  const sends: string[] = [];
  const ledger = new Set<string>();
  const deps: ClaimNoticeSendDeps = {
    readBoard: () => ({ schema: 'fleet.coordination.v1', state: boardState, claims: [claim],
      messages: [], proposals: [], expiredClaims: 0 }),
    readPrevSnapshot: () => snapshot,
    writePrevSnapshot: value => { snapshot = value; writes.push(value); },
    readBindings: () => [{ claimId: claim.id, repo: claim.repo, threadKey: 'fake-thread' }],
    readSentLedger: () => readable ? ledger : null,
    appendSentLedger: key => { ledger.add(key); },
    send: (_thread, text) => { sends.push(text); return { ok: true }; },
    now: () => clock,
  };
  const tick = createClaimNoticeTick({ now: () => clock, killed: () => false,
    pass: () => runClaimNoticePass(deps) });
  return { tick, sends, writes, ledger, snapshot: () => snapshot,
    advance: () => { clock += 30_000; },
    setBoard: (state: FleetBoard['state']) => { boardState = state; },
    setReadable: (value: boolean) => { readable = value; } };
}

describe('claim notice tick blocked evidence', () => {
  it.each([
    ['board', 'board-unavailable', 'board-state-unknown'],
    ['ledger', 'ledger-unavailable', 'sent-ledger-unreadable'],
  ] as const)('reports %s unavailability and recovers on the next interval', async (kind, status, reason) => {
    const h = harness();
    const previous = h.snapshot();
    if (kind === 'board') h.setBoard('unknown');
    else h.setReadable(false);
    expect(await h.tick.maybeRun()).toEqual({ ran: true, status, reason, sent: 0, deduped: 0, failed: 0 });
    expect(h.sends).toHaveLength(0);
    expect(h.writes).toHaveLength(0);
    expect(h.snapshot()).toBe(previous);
    expect(await h.tick.maybeRun()).toEqual({ ran: false, reason: 'interval' });
    h.setBoard('known');
    h.setReadable(true);
    h.advance();
    expect(await h.tick.maybeRun()).toEqual({ ran: true, sent: 1, deduped: 0, failed: 0 });
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]).toContain('ASSIGNED');
    expect(h.ledger.size).toBe(1);
    expect(h.writes).toHaveLength(1);
  });

  it('reports actual counts for a normal completed pass', async () => {
    const h = harness();
    expect(await h.tick.maybeRun()).toEqual({ ran: true, sent: 1, deduped: 0, failed: 0 });
    h.advance();
    expect(await h.tick.maybeRun()).toEqual({ ran: true, sent: 0, deduped: 0, failed: 0 });
    expect(h.sends).toHaveLength(1);
  });
});
