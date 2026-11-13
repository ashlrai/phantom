/**
 * Heartbeat leadership lease for a role slot. The holder is an agent running
 * on some lane; nothing ties it to a model. While heartbeats arrive inside the
 * TTL the lease is live; once they stop, ANY eligible agent may take over.
 *
 * `epoch` is a fencing token: it increases on every fresh acquisition, so a
 * stale holder that wakes up after a takeover fails its next heartbeat and
 * must stand down. Pure state transitions; the caller persists the lease
 * (under a store lock) and supplies the clock.
 */
import type { RoleResolution, RoleSlot } from './role-slots.js';

/** Heartbeat about every ttl/3 so one missed beat does not forfeit the lease. */
export const DEFAULT_LEASE_TTL_MS = 90_000;

export interface LeaseHolder {
  agentId: string;
  seatId: string;
}

export interface RoleLease {
  role: RoleSlot;
  epoch: number;
  holder: LeaseHolder | null;
  acquiredAtMs: number;
  heartbeatAtMs: number;
  ttlMs: number;
}

export type LeaseState = 'vacant' | 'live' | 'expired';

export function leaseState(lease: RoleLease | null, nowMs: number): LeaseState {
  if (!lease?.holder) return 'vacant';
  return nowMs - lease.heartbeatAtMs <= lease.ttlMs ? 'live' : 'expired';
}

export type ClaimResult =
  | { ok: true; lease: RoleLease; takeover: boolean }
  | { ok: false; reason: 'held'; holder: LeaseHolder; expiresAtMs: number };

/** Acquire when vacant or expired; the live holder renews its own claim. */
export function claimLease(
  lease: RoleLease | null,
  role: RoleSlot,
  claimant: LeaseHolder,
  nowMs: number,
  ttlMs: number = DEFAULT_LEASE_TTL_MS,
): ClaimResult {
  const state = leaseState(lease, nowMs);
  if (lease?.holder && state === 'live') {
    if (lease.holder.agentId !== claimant.agentId) {
      return { ok: false, reason: 'held', holder: lease.holder, expiresAtMs: lease.heartbeatAtMs + lease.ttlMs };
    }
    return { ok: true, takeover: false, lease: { ...lease, holder: claimant, heartbeatAtMs: nowMs, ttlMs } };
  }
  return {
    ok: true,
    takeover: state === 'expired',
    lease: { role, epoch: (lease?.epoch ?? 0) + 1, holder: claimant, acquiredAtMs: nowMs, heartbeatAtMs: nowMs, ttlMs },
  };
}

export type HeartbeatResult =
  | { ok: true; lease: RoleLease }
  | { ok: false; reason: 'lost' };

/** Renew. Fails once another agent took over (different holder or epoch), even if this one is merely late. */
export function heartbeatLease(lease: RoleLease | null, agentId: string, epoch: number, nowMs: number): HeartbeatResult {
  if (!lease?.holder || lease.holder.agentId !== agentId || lease.epoch !== epoch) return { ok: false, reason: 'lost' };
  return { ok: true, lease: { ...lease, heartbeatAtMs: nowMs } };
}

/** Voluntary release; only the current holder at the current epoch can vacate. */
export function releaseLease(lease: RoleLease | null, agentId: string, epoch: number): RoleLease | null {
  if (!lease?.holder || lease.holder.agentId !== agentId || lease.epoch !== epoch) return lease;
  return { ...lease, holder: null };
}

export type LeadershipAction =
  | { kind: 'renew' }
  | { kind: 'claim'; takeover: boolean }
  | { kind: 'yield'; reason: string }
  | { kind: 'follow'; holder: LeaseHolder }
  | { kind: 'stand-by'; reason: string };

/**
 * What this agent should do now. Holding requires the agent's own lane to be
 * a current candidate for the slot, so a lane that exhausts yields and the
 * next best lane takes over once the lease is vacant or expires.
 */
export function decideLeadership(
  lease: RoleLease | null,
  self: LeaseHolder,
  resolution: RoleResolution,
  nowMs: number,
): LeadershipAction {
  const eligible = resolution.candidates.some((c) => c.seatId === self.seatId);
  const state = leaseState(lease, nowMs);
  const mine = state === 'live' && lease?.holder?.agentId === self.agentId;
  if (mine) {
    return eligible ? { kind: 'renew' } : { kind: 'yield', reason: `${self.seatId} can no longer hold the ${resolution.role} slot.` };
  }
  if (state === 'live' && lease?.holder) return { kind: 'follow', holder: lease.holder };
  if (!eligible) return { kind: 'stand-by', reason: `${self.seatId} is not an eligible lane for the ${resolution.role} slot.` };
  return { kind: 'claim', takeover: state === 'expired' };
}
