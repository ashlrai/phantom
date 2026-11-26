/**
 * Poll cadence. An allowance whose lane is running jobs is read about once a
 * minute. A reading that did not change doubles the wait, up to ten minutes.
 * An idle lane waits ten minutes. A lane that becomes active is read within a
 * minute of its last poll, whatever wait was chosen while it was idle.
 */
import type { PollState, ResourceLiveReading } from './types.js';

export const ACTIVE_POLL_MS = 60_000;
export const IDLE_POLL_MS = 10 * 60_000;

export function nextResetCheck(observed: number, end: number): number {
  const lead = end - 2 * 60_000;
  return observed < lead ? lead : end;
}

/** What makes two readings the same observation of the same window. */
export function readingFingerprint(reading: Pick<ResourceLiveReading, 'verified' | 'used' | 'limit' | 'reset_at' | 'source'>): string {
  return reading.verified ? `${reading.used}|${reading.limit}|${reading.reset_at}|${reading.source}` : 'unverified';
}

export function pollDue(state: PollState | undefined, active: boolean, nowMs: number): boolean {
  if (!state) return true;
  const last = Date.parse(state.last_polled_at);
  const next = Date.parse(state.next_poll_at);
  // A clock that moved backwards, or a malformed row, polls now.
  if (!Number.isFinite(last) || !Number.isFinite(next) || last > nowMs) return true;
  if (nowMs >= next) return true;
  return active && !state.active && nowMs - last >= ACTIVE_POLL_MS;
}

export function nextPollState(prior: PollState | undefined, fingerprint: string, active: boolean, nowMs: number): PollState {
  const changed = prior === undefined || prior.fingerprint !== fingerprint;
  let intervalMs = IDLE_POLL_MS;
  if (active) {
    const previous = prior && prior.active ? prior.interval_s * 1000 : ACTIVE_POLL_MS;
    intervalMs = changed ? ACTIVE_POLL_MS : Math.min(IDLE_POLL_MS, Math.max(ACTIVE_POLL_MS, previous * 2));
  }
  return {
    last_polled_at: new Date(nowMs).toISOString(),
    next_poll_at: new Date(nowMs + intervalMs).toISOString(),
    interval_s: intervalMs / 1000,
    active,
    fingerprint,
  };
}

/** Earliest next poll, never sooner than one second from now. */
export function nextWakeMs(states: readonly (PollState | undefined)[], nowMs: number): number {
  let wake = nowMs + IDLE_POLL_MS;
  for (const state of states) {
    const at = state ? Date.parse(state.next_poll_at) : NaN;
    if (Number.isFinite(at) && at < wake) wake = at;
  }
  return Math.max(nowMs + 1000, wake);
}
