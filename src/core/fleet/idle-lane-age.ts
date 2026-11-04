import type { LaneLedgerEvent } from './lane-console.js';
import type { IdleLane } from './idle-lanes.js';

export interface IdleLaneAge extends IdleLane {
  lastEventAt: string | null;
  quietMin: number | null;
  stuck: boolean;
}

export const DEFAULT_STUCK_AFTER_MIN = 30;

// An offset is required: otherwise Date.parse depends on the host timezone.
const ISO_WITH_OFFSET = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/i;

function eventMs(at: string | null): number | null {
  if (!at || !ISO_WITH_OFFSET.test(at)) return null;
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : null;
}

/** True when at least one event names a pool and carries a usable timestamp. */
export function hasPooledDatedEvent(events: LaneLedgerEvent[]): boolean {
  return events.some(event => event.pool !== null && eventMs(event.at) !== null);
}

/**
 * Attach the time since each lane's newest ledger event. Pure: the caller
 * supplies `nowMs`. A lane with no usable event has unknown (null) age and is
 * never stuck; only a red lane quiet for `stuckAfterMin` or more is stuck.
 */
export function idleLaneAges(
  lanes: IdleLane[],
  events: LaneLedgerEvent[],
  nowMs: number,
  stuckAfterMin = DEFAULT_STUCK_AFTER_MIN,
): IdleLaneAge[] {
  const newest = new Map<string, { ms: number; at: string }>();
  for (const event of events) {
    const ms = eventMs(event.at);
    if (event.pool === null || ms === null) continue;
    if (ms > (newest.get(event.pool)?.ms ?? -Infinity)) newest.set(event.pool, { ms, at: event.at! });
  }
  return lanes.map(lane => {
    const last = newest.get(lane.lane);
    if (!last) return { ...lane, lastEventAt: null, quietMin: null, stuck: false };
    const quietMin = Math.max(0, Math.floor((nowMs - last.ms) / 60_000));
    return { ...lane, lastEventAt: last.at, quietMin, stuck: lane.status === 'red' && quietMin >= stuckAfterMin };
  });
}
