/** Pure coordination deltas. Return receipts name evidence; they do not authenticate it. */
import type { FleetBoard } from './coordination.js';
import { projectCoordinationReturns } from './coordination-returns-view.js';
import { scrubSecrets } from '../util/scrub.js';

export interface ClaimThreadSnapshot extends Pick<FleetBoard, 'state' | 'claims' | 'messages'> {
  /** Captured read clock, needed to distinguish expiry from an unchanged replay. */
  asOf: number;
}
export interface ClaimThreadBinding {
  claimId: string;
  repo: string;
  /** Exact source thread reference; never a channel-wide fallback. */
  threadKey: string;
  pr?: number;
  head?: string;
}
export interface ClaimThreadNotice {
  threadKey: string;
  state: 'ASSIGNED' | 'RELEASED' | 'BLOCKED' | 'VERIFIED';
  text: string;
  dedupeKey: string;
}
const field = (value: string): string => Array.from(scrubSecrets(value), c =>
  c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c).join('')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function returns(snapshot: ClaimThreadSnapshot) {
  // Project one receipt at a time so the UI projection's 50-row cap cannot drop a delta.
  return snapshot.messages.filter(m => m.at <= snapshot.asOf && m.expiresAt > snapshot.asOf).flatMap(message =>
    projectCoordinationReturns({ schema: 'fleet.coordination.v1', state: snapshot.state,
      claims: [], messages: [message], proposals: [], expiredClaims: 0 }, snapshot.asOf).returns);
}

/** Unknown reads never prove release. The caller's sent ledger must fence dedupeKey across retries. */
export function planClaimThreadNotices(
  prev: ClaimThreadSnapshot, next: ClaimThreadSnapshot,
  bindings: readonly ClaimThreadBinding[], now: number,
): ClaimThreadNotice[] {
  if (prev.state !== 'known' || next.state !== 'known' || !Number.isFinite(now)
    || !Number.isFinite(prev.asOf) || !Number.isFinite(next.asOf)
    || next.asOf < prev.asOf || now < next.asOf || Math.abs(now) > 8.64e15) return [];
  const live = (snapshot: ClaimThreadSnapshot) => new Map(snapshot.claims
    .filter(c => c.claimedAt <= snapshot.asOf && c.expiresAt > snapshot.asOf).map(c => [c.id, c]));
  const before = live(prev), after = live(next);
  const oldReturns = new Set(returns(prev).map(r => JSON.stringify([r.result, r.claimId, r.head])));
  const returned = returns(next);
  const notices: ClaimThreadNotice[] = [];
  const seen = new Set<string>();
  const add = (state: ClaimThreadNotice['state'], id: string, repo: string, owner: string,
    evidence: string, pr?: number | null, head?: string | null) => {
    const matches = bindings.filter(b => b.claimId === id && b.repo === repo);
    // Conflicting routes are unsafe even if one looks plausible.
    if (matches.length !== 1 || !matches[0]!.threadKey.trim()) return;
    const binding = matches[0]!;
    const actualHead = head ?? binding.head;
    const dedupeKey = JSON.stringify([state, id, actualHead ?? 'unknown']);
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    const target = `${repo}#${pr ?? binding.pr ?? '?'}@${actualHead?.slice(0, 7) ?? 'unknown'}`;
    notices.push({ threadKey: binding.threadKey, state, dedupeKey,
      text: `${state}: ${field(owner)} ${field(target)} claim ${field(id)}; ${field(evidence)}; as of ${new Date(now).toISOString()}` });
  };
  for (const claim of after.values()) {
    const old = before.get(claim.id);
    if (!old || old.agent !== claim.agent) add('ASSIGNED', claim.id, claim.repo, claim.agent, 'claim acquired');
  }
  for (const row of returned) {
    if (oldReturns.has(JSON.stringify([row.result, row.claimId, row.head]))) continue;
    add(row.result, row.claimId, row.repo, row.from, row.evidence, row.pr, row.head);
  }
  for (const claim of before.values()) {
    if (after.has(claim.id) || returned.some(r => r.claimId === claim.id && r.repo === claim.repo)) continue;
    add('RELEASED', claim.id, claim.repo, claim.agent, claim.expiresAt <= next.asOf ? 'claim expired' : 'claim released');
  }
  return notices;
}
