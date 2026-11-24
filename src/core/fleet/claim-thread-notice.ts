/** Pure coordination deltas. Return receipts name evidence; they do not authenticate it. */
import type { FleetBoard } from './coordination.js';
import { createHash } from 'node:crypto';
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
      claims: [], messages: [message], proposals: [], expiredClaims: 0 }, snapshot.asOf).returns.map(row => ({
        ...row,
        // Match the writer's final task delimiter, as the projection does, but
        // hash full dependency evidence before the display's 300-character cap.
        blockerKey: row.result === 'BLOCKED' ? createHash('sha256')
          .update(/^RESULT BLOCKED .+ task ".+": (dependency .+)$/.exec(message.body)![1]!)
          .digest('hex') : undefined,
      })));
}

/** Live claims are repository-qualified: the same claim id can be held in
 * two repositories at once and must diff independently. */
const claimKey = (repo: string, id: string): string => JSON.stringify([repo, id]);

/** Unknown reads never prove release. The caller's sent ledger must fence dedupeKey across retries. */
export function planClaimThreadNotices(
  prev: ClaimThreadSnapshot, next: ClaimThreadSnapshot,
  bindings: readonly ClaimThreadBinding[], now: number,
  noticeTimes?: ReadonlyMap<string, number>,
): ClaimThreadNotice[] {
  if (prev.state !== 'known' || next.state !== 'known' || !Number.isFinite(now)
    || !Number.isFinite(prev.asOf) || !Number.isFinite(next.asOf)
    || next.asOf < prev.asOf || now < next.asOf || Math.abs(now) > 8.64e15) return [];
  const live = (snapshot: ClaimThreadSnapshot) => new Map(snapshot.claims
    .filter(c => c.claimedAt <= snapshot.asOf && c.expiresAt > snapshot.asOf)
    .map(c => [claimKey(c.repo, c.id), c]));
  const before = live(prev), after = live(next);
  const prevReturns = returns(prev), nextReturns = returns(next);
  // Return receipts are repository-scoped evidence: the same claim id can
  // carry a receipt in each repository and neither may fence the other.
  const returnSeen = (r: (typeof prevReturns)[number]) =>
    JSON.stringify([r.result, r.repo, r.claimId, r.head, ...(r.blockerKey ? [r.blockerKey] : [])]);
  const oldReturns = new Set(prevReturns.map(returnSeen));
  // A claim id observed in more than one repository (live claims or return
  // receipts in either snapshot) earns a repo-qualified notice identity so
  // the durable sent ledger cannot fence one repository's notice with
  // another's. Notices without fresh acquisition evidence keep the legacy
  // [state, claimId, head] key so historical keys still fence those replays.
  const claimRepos = new Map<string, Set<string>>();
  const noteRepo = (id: string, repo: string) => {
    const repos = claimRepos.get(id) ?? new Set<string>();
    repos.add(repo);
    claimRepos.set(id, repos);
  };
  for (const claim of [...prev.claims, ...next.claims]) noteRepo(claim.id, claim.repo);
  for (const row of [...prevReturns, ...nextReturns]) noteRepo(row.claimId, row.repo);
  const notices: ClaimThreadNotice[] = [];
  const seen = new Set<string>();
  const add = (state: ClaimThreadNotice['state'], id: string, repo: string, owner: string,
    evidence: string, pr?: number | null, head?: string | null,
    transition?: { agent: string; claimedAt: number }, blockerKey?: string) => {
    const matches = bindings.filter(b => b.claimId === id && b.repo === repo);
    // Conflicting routes are unsafe even if one looks plausible.
    if (matches.length !== 1 || !matches[0]!.threadKey.trim()) return;
    const binding = matches[0]!;
    const actualHead = head ?? binding.head;
    const tail = actualHead ?? 'unknown';
    // A proven fresh acquisition or handoff gets a fully qualified identity
    // (repo, owner, acquisition clock):
    // owner A -> B -> A and distinct acquisitions can never collide with
    // the earlier owner's ledgered key, while an identical replay recomputes
    // the same fields and stays fenced.
    const repos = claimRepos.get(id);
    const dedupeKey = blockerKey !== undefined
      ? JSON.stringify([state, repo, id, tail, blockerKey])
      : transition !== undefined
      ? JSON.stringify([state, repo, id, transition.agent, transition.claimedAt, tail])
      : repos !== undefined && repos.size > 1
        ? JSON.stringify([state, repo, id, tail])
        : JSON.stringify([state, id, tail]);
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    const target = `${repo}#${pr ?? binding.pr ?? '?'}@${actualHead?.slice(0, 7) ?? 'unknown'}`;
    notices.push({ threadKey: binding.threadKey, state, dedupeKey,
      text: `${state}: ${field(owner)} ${field(target)} claim ${field(id)}; ${field(evidence)}; as of ${new Date(noticeTimes?.get(dedupeKey) ?? now).toISOString()}` });
  };
  for (const claim of after.values()) {
    const old = before.get(claimKey(claim.repo, claim.id));
    // claimedAt moves on every handoff/re-acquisition, so an owner change or
    // a fresh acquisition clock under a known claim id is a new assignment.
    if (!old || old.agent !== claim.agent || old.claimedAt !== claim.claimedAt) {
      add('ASSIGNED', claim.id, claim.repo, claim.agent, 'claim acquired', undefined, undefined,
        // A clock after the known absent snapshot proves a new acquisition,
        // even when that snapshot no longer contains the previous owner.
        // Older/equal clocks retain legacy replay fencing: the planner has
        // no evidence to distinguish historical delivery from late discovery.
        old !== undefined || claim.claimedAt > prev.asOf
          ? { agent: claim.agent, claimedAt: claim.claimedAt } : undefined);
    }
  }
  for (const row of nextReturns) {
    // Unchanged historical receipts stay silent even with legacy sent keys;
    // only BLOCKED evidence gains an identity, never old VERIFIED results.
    if (oldReturns.has(returnSeen(row))) continue;
    add(row.result, row.claimId, row.repo, row.from, row.evidence, row.pr, row.head, undefined, row.blockerKey);
  }
  for (const claim of before.values()) {
    const key = claimKey(claim.repo, claim.id);
    if (after.has(key) || nextReturns.some(r => r.claimId === claim.id && r.repo === claim.repo)) continue;
    add('RELEASED', claim.id, claim.repo, claim.agent,
      claim.expiresAt <= next.asOf ? 'claim expired' : 'claim released', undefined, undefined,
      { agent: claim.agent, claimedAt: claim.claimedAt });
  }
  return notices;
}
