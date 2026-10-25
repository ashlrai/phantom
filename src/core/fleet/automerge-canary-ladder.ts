/**
 * Canary enforce ladder state machine (design-autonomy-canary.md 4.3, PR plan
 * step 3; Orchestrator decisions of 2026-10-25).
 *
 * States: shadow -> armed -> enforce, and rollback to shadow from any state.
 * The default and pinned state is shadow. `enforce` is unreachable unless
 * both code constants HOST_CANCELLATION_PROVEN and
 * AUTOMERGE_CANARY_ENFORCE_SUPPORTED are true; neither is read from config
 * or env, and both are false. Every attempted transition, allowed or refused,
 * writes one value-free audit record first; if the record cannot be written,
 * the transition does not happen (fail closed), except a move to shadow, which
 * only lowers authority and is never blocked. Not wired into any runtime path.
 */
import { HOST_CANCELLATION_PROVEN, type HostCancellationResult } from './automerge-canary-cancel.js';
import { AUTOMERGE_CANARY_ENFORCE_SUPPORTED } from './automerge-canary-store.js';

export const CANARY_LADDER_STATES = ['shadow', 'armed', 'enforce'] as const;
export type CanaryLadderState = (typeof CANARY_LADDER_STATES)[number];
export const CANARY_LADDER_EVENTS = ['arm', 'enforce', 'rollback'] as const;
export type CanaryLadderEvent = (typeof CANARY_LADDER_EVENTS)[number];
export const CANARY_LADDER_DEFAULT_STATE: CanaryLadderState = 'shadow';

export type CanaryLadderRefusal =
  | 'state-unknown'
  | 'event-unknown'
  | 'illegal-transition'
  | 'host-cancellation-unproven'
  | 'enforce-unsupported'
  | 'audit-unwritable';

export interface CanaryLadderAuditRecord {
  schema: 1;
  kind: 'automerge-canary-ladder';
  at: string;
  from: CanaryLadderState | 'unknown';
  event: CanaryLadderEvent | 'unknown';
  to: CanaryLadderState | null;
  result: 'applied' | 'refused';
  reason: Exclude<CanaryLadderRefusal, 'audit-unwritable'> | null;
}

export type CanaryLadderResult =
  | { ok: true; state: CanaryLadderState; auditWritten: boolean }
  | { ok: false; state: CanaryLadderState; reason: CanaryLadderRefusal };

/** Gates read from code constants only. Exported so tests can prove the pinned values. */
export function enforceGates(): { hostCancellationProven: boolean; enforceSupported: boolean } {
  return { hostCancellationProven: HOST_CANCELLATION_PROVEN, enforceSupported: AUTOMERGE_CANARY_ENFORCE_SUPPORTED };
}

const isState = (v: unknown): v is CanaryLadderState => (CANARY_LADDER_STATES as readonly unknown[]).includes(v);
const isEvent = (v: unknown): v is CanaryLadderEvent => (CANARY_LADDER_EVENTS as readonly unknown[]).includes(v);

function decide(from: CanaryLadderState, event: CanaryLadderEvent): { to: CanaryLadderState } | { reason: CanaryLadderRefusal } {
  if (event === 'rollback') return { to: 'shadow' };
  if (event === 'arm') return from === 'shadow' ? { to: 'armed' } : { reason: 'illegal-transition' };
  // event === 'enforce'
  if (from !== 'armed') return { reason: 'illegal-transition' };
  const gates = enforceGates();
  if (!gates.hostCancellationProven) return { reason: 'host-cancellation-unproven' };
  if (!gates.enforceSupported) return { reason: 'enforce-unsupported' };
  return { to: 'enforce' };
}

/**
 * Attempt one transition. `current` and `event` are untrusted input: anything
 * unknown is refused and the safe state is shadow. Never throws.
 */
export function transitionCanaryLadder(
  current: unknown,
  event: unknown,
  deps: { writeAudit: (record: CanaryLadderAuditRecord) => boolean; now?: () => Date },
): CanaryLadderResult {
  const at = (deps.now?.() ?? new Date()).toISOString();
  const from = isState(current) ? current : null;
  const ev = isEvent(event) ? event : null;
  let outcome: { to: CanaryLadderState } | { reason: CanaryLadderRefusal };
  if (!from) outcome = { reason: 'state-unknown' };
  else if (!ev) outcome = { reason: 'event-unknown' };
  else outcome = decide(from, ev);
  // Unknown state: the safe place is shadow; a rollback from unknown is allowed.
  if (!from && ev === 'rollback') outcome = { to: 'shadow' };
  const record: CanaryLadderAuditRecord = {
    schema: 1,
    kind: 'automerge-canary-ladder',
    at,
    from: from ?? 'unknown',
    event: ev ?? 'unknown',
    to: 'to' in outcome ? outcome.to : null,
    result: 'to' in outcome ? 'applied' : 'refused',
    reason: 'to' in outcome ? null : (outcome.reason as CanaryLadderAuditRecord['reason']),
  };
  let written = false;
  try { written = deps.writeAudit(record) === true; } catch { written = false; }
  const stay: CanaryLadderState = from ?? CANARY_LADDER_DEFAULT_STATE;
  // A move toward shadow lowers authority, so it is never blocked by a failed
  // audit write (the caller sees auditWritten:false). Anything else fails closed.
  if (!written) {
    if ('to' in outcome && outcome.to === 'shadow') return { ok: true, state: 'shadow', auditWritten: false };
    return { ok: false, state: stay, reason: 'audit-unwritable' };
  }
  if ('to' in outcome) return { ok: true, state: outcome.to, auditWritten: true };
  return { ok: false, state: stay, reason: outcome.reason };
}

/** Value-free audit record for a cancellation attempt. No repo, PR number, SHA or names. */
export interface CanaryCancelAuditRecord {
  schema: 1;
  kind: 'automerge-canary-cancel';
  at: string;
  outcome: HostCancellationResult['outcome'];
  race: boolean;
  reason: string | null;
  rolled_back: boolean;
}

export interface CanaryCancelReconcileResult {
  /** True only for cancelled-confirmed. A raced merge is never cancelled. */
  cancelled: boolean;
  state: CanaryLadderState;
  auditWritten: boolean;
}

/**
 * Apply a cancellation result to the ladder. A merge (raced or not) and any
 * unconfirmed cancel are fail-safe: never reported as cancelled, audited, and
 * the ladder rolls back to shadow. Never throws.
 */
export function reconcileCanaryCancellation(
  current: unknown,
  result: HostCancellationResult,
  deps: { writeAudit: (record: CanaryLadderAuditRecord | CanaryCancelAuditRecord) => boolean; now?: () => Date },
): CanaryCancelReconcileResult {
  const cancelled = result.outcome === 'cancelled-confirmed';
  const rollBack = result.outcome === 'merged' || result.outcome === 'not-confirmed';
  const record: CanaryCancelAuditRecord = {
    schema: 1,
    kind: 'automerge-canary-cancel',
    at: (deps.now?.() ?? new Date()).toISOString(),
    outcome: result.outcome,
    race: result.outcome === 'merged' ? result.race === true : false,
    reason: result.outcome === 'not-confirmed' ? result.reason : null,
    rolled_back: rollBack,
  };
  let written = false;
  try { written = deps.writeAudit(record) === true; } catch { written = false; }
  if (rollBack) {
    const r = transitionCanaryLadder(current, 'rollback', deps);
    return { cancelled: false, state: r.state, auditWritten: written && r.ok && r.auditWritten };
  }
  const stay = isState(current) ? current : CANARY_LADDER_DEFAULT_STATE;
  return { cancelled, state: stay, auditWritten: written };
}
