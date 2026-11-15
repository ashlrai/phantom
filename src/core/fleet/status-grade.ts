/**
 * core/fleet/status-grade.ts: the Nov12 22:29 ET reporting contract as one
 * pure grader. A status reply may say RECEIVED, ASSIGNED, RUNNING, BLOCKED or
 * VERIFIED only when structured evidence proves it; prose ("routed") never
 * does. Every grade carries an as-of timestamp and the evidence source.
 *
 * Precedence (strongest claim first): VERIFIED, BLOCKED, RUNNING, ASSIGNED,
 * RECEIVED, UNKNOWN. BLOCKED outranks RUNNING/ASSIGNED, matching
 * comms/work-item-state.ts. Pure: no I/O, no clock reads; the caller passes `now`.
 */
export type GradedWord = 'RECEIVED' | 'ASSIGNED' | 'RUNNING' | 'BLOCKED' | 'VERIFIED' | 'UNKNOWN';

export interface WorkStatusEvidence {
  ingressReceiptId?: string;
  owner?: string;
  claimId?: string;
  /** ISO timestamp; absent means the claim carries no known expiry. */
  claimExpiresAt?: string;
  processAlive?: boolean;
  lastProgressAt?: string;
  blockedBy?: string;
  prNumber?: number;
  headSha?: string;
  testsPassed?: boolean;
  /** ISO timestamp of the reply clock. */
  now: string;
}

export interface WorkStatusGrade {
  word: GradedWord;
  /** ISO timestamp the grade is true as of ('unknown' when `now` is unreadable). */
  asOf: string;
  /** Evidence fields the grade rests on, e.g. "claimId+processAlive". */
  source: string;
  reason: string;
}

/** Progress older than this no longer proves RUNNING. */
export const RUNNING_PROGRESS_MAX_MS = 15 * 60 * 1000;
/** Progress stamped further ahead of `now` than this is not trusted. */
const FUTURE_SKEW_MS = 5 * 60 * 1000;

const text = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

export function gradeWorkStatus(e: WorkStatusEvidence): WorkStatusGrade {
  const nowMs = Date.parse(e.now);
  if (!Number.isFinite(nowMs)) {
    return { word: 'UNKNOWN', asOf: 'unknown', source: 'none', reason: 'reply clock unreadable' };
  }
  const asOf = new Date(nowMs).toISOString();
  const grade = (word: GradedWord, source: string, reason: string): WorkStatusGrade => ({ word, asOf, source, reason });

  if (Number.isInteger(e.prNumber) && (e.prNumber as number) > 0 && text(e.headSha) && e.testsPassed === true) {
    return grade('VERIFIED', 'prNumber+headSha+testsPassed', `PR #${e.prNumber} head ${e.headSha.trim().slice(0, 12)} tests passed`);
  }
  if (text(e.blockedBy)) return grade('BLOCKED', 'blockedBy', `blocked by ${e.blockedBy.trim()}`);

  const hasClaim = text(e.claimId);
  let expired = false;
  if (hasClaim && e.claimExpiresAt !== undefined) {
    const exp = Date.parse(e.claimExpiresAt);
    expired = !Number.isFinite(exp) || exp <= nowMs; // unreadable expiry fails closed
  }
  if (hasClaim && expired) return grade('RECEIVED', 'claimId+claimExpiresAt', 'claim expired');

  if (hasClaim) {
    const progressMs = text(e.lastProgressAt) ? Date.parse(e.lastProgressAt) : NaN;
    const age = nowMs - progressMs;
    const fresh = Number.isFinite(progressMs) && age <= RUNNING_PROGRESS_MAX_MS && age >= -FUTURE_SKEW_MS;
    if (e.processAlive === true) return grade('RUNNING', 'claimId+processAlive', 'claim held and process alive');
    if (fresh) return grade('RUNNING', 'claimId+lastProgressAt', 'claim held and progress within 15 min');
    if (text(e.owner)) {
      const why = text(e.lastProgressAt) ? 'claim held, progress stale or unreadable' : 'claim held, no running evidence';
      return grade('ASSIGNED', 'owner+claimId', why);
    }
  }
  if (text(e.ingressReceiptId)) {
    const why = hasClaim ? 'claim held but no named owner' : text(e.owner) ? 'owner named but no claimId' : 'ingress receipt only';
    return grade('RECEIVED', 'ingressReceiptId', why);
  }
  return grade('UNKNOWN', 'none', 'no structured evidence');
}
