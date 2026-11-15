/** Public, read-only claim projection. Advisory ownership grants no authority. */
import type { FleetBoard } from './coordination.js';

function iso(ms: number): string {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : 'unknown';
}

/** Explicitly select fields so messages, proposals and lease material stay local. */
export function projectCoordinationClaims(board: FleetBoard | null, nowMs: number) {
  const base = { v: 1 as const, source: 'coordination-ledger' as const, asOf: iso(nowMs) };
  if (board === null) {
    return { ...base, state: 'unknown' as const, claims: [], expiredClaims: null,
      reason: 'coordination ledger: reader failed' };
  }
  const claims = [...board.claims]
    .sort((a, b) => b.claimedAt - a.claimedAt)
    .slice(0, 50)
    .map(c => ({
      id: c.id, repo: c.repo, task: String(c.task).slice(0, 200), agent: c.agent,
      claimedAt: iso(c.claimedAt), expiresAt: iso(c.expiresAt),
      expiresInSeconds: Math.round((c.expiresAt - nowMs) / 1000),
    }));
  return { ...base, state: board.state, claims, expiredClaims: board.expiredClaims };
}
