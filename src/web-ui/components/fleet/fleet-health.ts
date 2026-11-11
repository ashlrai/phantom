/**
 * components/fleet/fleet-health.ts — pure projection from the lane console
 * snapshot (GET /api/fleet/lanes, fleet.lanes.v1) to the compact per-lane
 * chips rendered by <FleetHealthStrip/> on Show mode and the Fleet
 * Dashboard.
 *
 * Honesty rule (same as LanesPanel's): every counter may be null — a lane
 * reports "—" rather than an invented zero, and a lane whose credit source
 * is 'unknown' renders the word "unknown" with no bar, never a guessed
 * percentage.
 */
import type { FleetLaneSnapshot } from '../../data/api-types.js';

export interface LaneHealth {
  lane: string;
  /** In-flight jobs (queue.v1.json authoritative); null when unobserved. */
  live: number | null;
  /** Slot target from lane-targets; null when unobserved or not reported. */
  target: number | null;
  /** READY jobs queued for the lane; null when the queue read was degraded. */
  queue: number | null;
  /** Merges/hour over the trailing window; null when unmeasured. */
  mergesPerHour: number | null;
  /** Compact credit summary when observed/reset-pending; null when unknown. */
  creditLabel: string | null;
  /** 0–100 remaining percent; null when the lane reports none. */
  creditPct: number | null;
  creditState: 'observed' | 'reset-pending' | 'unknown';
  held: boolean;
  holdReason: string | null;
}

export function buildLaneHealth(snapshot: FleetLaneSnapshot | undefined): LaneHealth[] {
  return (snapshot?.lanes ?? []).map((lane) => {
    const known = lane.credit.state === 'observed' || lane.credit.state === 'reset-pending';
    const pct = lane.credit.remainingPct;
    return {
      lane: lane.lane,
      live: lane.liveJobs,
      target: lane.slotTarget ?? null,
      queue: lane.queueDepth,
      mergesPerHour: lane.mergesPerHour,
      creditLabel: known ? lane.credit.label : null,
      creditPct: pct === null ? null : Math.min(100, Math.max(0, pct)),
      creditState: lane.credit.state,
      held: lane.hold?.held === true,
      holdReason: lane.hold?.reason ?? null,
    };
  });
}

/** `live/target` with honest dashes, e.g. `2/6`, `—/6`, `2/—`. */
export function liveOverTarget(health: LaneHealth): string {
  const live = health.live === null ? '—' : String(health.live);
  const target = health.target === null ? '—' : String(health.target);
  return `${live}/${target}`;
}
