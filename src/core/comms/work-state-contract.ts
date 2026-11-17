/**
 * Work-state contract for fleet coordination replies (pure, no I/O).
 *
 * A reply may only say RECEIVED, ASSIGNED, RUNNING, BLOCKED or VERIFIED when
 * structured evidence supports it. State is never inferred from free text.
 */

export type WorkState = 'RECEIVED' | 'ASSIGNED' | 'RUNNING' | 'BLOCKED' | 'VERIFIED';

export interface WorkEvidence {
  /** ISO timestamp the request arrived. Required. */
  receivedAt: string;
  /** Where the request came from, e.g. 'slack', 'imessage', 'page'. */
  source: string;
  /** Named owner. */
  owner?: string;
  /** Durable claim/task receipt id. */
  claimReceipt?: string;
  /** ISO timestamp of the most recent proof the owner is working. */
  liveEvidenceAt?: string;
  /** Specific dependency text. */
  blocker?: string;
  artifact?: { pr?: number; head?: string; testsPassed?: boolean };
}

export interface WorkStateVerdict {
  state: WorkState;
  /** now.toISOString(): when this verdict was computed. */
  asOf: string;
  source: string;
  reasons: string[];
  /** True when live evidence exists but is older than the staleness window. */
  stale: boolean;
}

const DEFAULT_LIVE_STALE_MS = 30 * 60_000;

function nonEmpty(s: string | undefined): s is string {
  return typeof s === 'string' && s.trim() !== '';
}

function parseIso(value: unknown): number {
  return typeof value === 'string' && value.trim() !== '' ? Date.parse(value) : Number.NaN;
}

export function classifyWorkState(
  e: WorkEvidence,
  now: Date,
  opts: { liveStaleMs?: number } = {},
): WorkStateVerdict {
  // Invalid or missing receivedAt: throw, never guess.
  if (Number.isNaN(parseIso(e?.receivedAt))) {
    throw new TypeError('classifyWorkState: receivedAt must be a valid ISO timestamp');
  }
  const nowMs = now.getTime();
  if (Number.isNaN(nowMs)) throw new TypeError('classifyWorkState: now must be a valid Date');

  const liveStaleMs = opts.liveStaleMs ?? DEFAULT_LIVE_STALE_MS;
  const base = { asOf: now.toISOString(), source: e.source };
  const reasons: string[] = [];

  // VERIFIED: needs artifact.pr AND artifact.head AND testsPassed === true.
  // Outranks everything, including a blocker.
  const a = e.artifact;
  if (a) {
    const hasPr = typeof a.pr === 'number' && Number.isInteger(a.pr) && a.pr > 0;
    const hasHead = nonEmpty(a.head);
    if (hasPr && hasHead && a.testsPassed === true) {
      return { ...base, state: 'VERIFIED', reasons: [`PR #${a.pr} at ${a.head}, tests passed`], stale: false };
    }
    if (hasPr) {
      if (!hasHead) reasons.push(`PR #${a.pr} has no head sha, not verified`);
      if (a.testsPassed !== true) reasons.push(`PR #${a.pr} tests not passed, not verified`);
    }
  }

  // BLOCKED: needs a non-empty blocker; outranks RUNNING and ASSIGNED.
  if (nonEmpty(e.blocker)) {
    return { ...base, state: 'BLOCKED', reasons: [...reasons, `blocked: ${e.blocker.trim()}`], stale: false };
  }

  // ASSIGNED: needs BOTH owner and claimReceipt. An owner alone is prose intent.
  const hasOwner = nonEmpty(e.owner);
  const hasClaim = nonEmpty(e.claimReceipt);
  if (!hasOwner || !hasClaim) {
    if (hasOwner) reasons.push('owner named, no durable claim');
    else if (hasClaim) reasons.push('claim receipt present, no named owner');
    else reasons.push('no owner or claim receipt');
    return { ...base, state: 'RECEIVED', reasons, stale: false };
  }
  const assigned = `owner ${e.owner!.trim()}, claim ${e.claimReceipt!.trim()}`;

  // RUNNING: ASSIGNED plus live evidence no older than liveStaleMs.
  // Older evidence downgrades to ASSIGNED with stale=true.
  if (e.liveEvidenceAt === undefined) {
    return { ...base, state: 'ASSIGNED', reasons: [...reasons, assigned, 'no live evidence'], stale: false };
  }
  const liveMs = parseIso(e.liveEvidenceAt);
  if (Number.isNaN(liveMs)) {
    return { ...base, state: 'ASSIGNED', reasons: [...reasons, assigned, 'liveEvidenceAt invalid, ignored'], stale: false };
  }
  const ageMs = nowMs - liveMs;
  if (ageMs < 0) {
    return { ...base, state: 'ASSIGNED', reasons: [...reasons, assigned, 'liveEvidenceAt is in the future, ignored'], stale: false };
  }
  if (ageMs > liveStaleMs) {
    const mins = Math.floor(ageMs / 60_000);
    return {
      ...base,
      state: 'ASSIGNED',
      reasons: [...reasons, assigned, `live evidence ${mins}m old, older than ${Math.floor(liveStaleMs / 60_000)}m`],
      stale: true,
    };
  }
  return { ...base, state: 'RUNNING', reasons: [...reasons, assigned, 'live evidence current'], stale: false };
}

/** One reply line: state, as-of timestamp and source always present. */
export function formatWorkStateLine(v: WorkStateVerdict): string {
  const tail = v.reasons.join('; ');
  const stale = v.stale ? ' [STALE]' : '';
  return `${v.state} as of ${v.asOf} (${v.source})${stale}${tail ? `: ${tail}` : ''}`;
}
