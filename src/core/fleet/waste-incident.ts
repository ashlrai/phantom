/** Waste-risk incident notices on the shared fleet bus. `fleet waste-risk`
 * projects which lanes will leave included capacity unused at reset; this turns
 * each 'high' row into one 'waste-high' P1 envelope per lane per clock hour so
 * planners, the phone and the desktop can read the fact. The hour bucket in the
 * id makes reruns 'duplicate'. Unknown, low and medium rows never raise an
 * incident, so missing evidence stays silent. Advisory only: this module never
 * changes lane targets, holds or dispatch. */
import { appendBusInbox, type BusInboxOptions, type BusInboxPost } from './bus-inbox.js';
import type { BusEnvelope } from './bus-envelope.js';
import { fleetBusEventId } from './bus-mirror-dispatch.js';
import { CHANNEL_BUS_TTL_MS } from './channel-bus-publish.js';
import type { WasteRiskProjection } from '../resources/waste-risk.js';

export const WASTE_INCIDENT_BUS_KIND = 'waste-high';
const HOUR_MS = 60 * 60 * 1000;

export interface WasteIncidentBody {
  kind: string;
  lane: string;
  /** Share of the included allowance projected to go unused, in percent. */
  projectedUnusedPct: number | null;
  hoursToReset: number;
  resetAt: string | null;
  recommendedTarget: number | null;
  text: string;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

export function planWasteIncidents(rows: readonly WasteRiskProjection[]): WasteRiskProjection[] {
  return rows.filter(row => row.waste_risk === 'high' &&
    typeof row.hours_to_reset === 'number' && Number.isFinite(row.hours_to_reset) && row.hours_to_reset > 0 &&
    typeof row.projected_unused_at_reset === 'number' && Number.isFinite(row.projected_unused_at_reset));
}

/** The projection carries unused/used amounts but not the limit; their sum is
 * the capped allowance, so the percentage derives from the two. */
function unusedPct(row: WasteRiskProjection): number | null {
  const unused = row.projected_unused_at_reset;
  const used = row.projected_used_at_reset;
  if (unused === null || used === null) return null;
  const limit = unused + used;
  return Number.isFinite(limit) && limit > 0 ? round1(unused / limit * 100) : null;
}

export function buildWasteIncidentEnvelope(row: WasteRiskProjection, nowMs: number): BusEnvelope<WasteIncidentBody> {
  // Floored to the clock hour so a rerun in the same hour dedupes in the inbox.
  const hour = new Date(Math.floor(nowMs / HOUR_MS) * HOUR_MS).toISOString();
  const pct = unusedPct(row);
  const hours = round1(row.hours_to_reset!);
  const text = `${row.lane}: ${pct === null ? 'unused capacity' : `${pct}% projected unused`} at reset in ${hours} h`;
  return {
    id: fleetBusEventId(WASTE_INCIDENT_BUS_KIND, hour, row.lane),
    from: 'fleet', to: 'all', priority: 'P1', ttl: CHANNEL_BUS_TTL_MS,
    body: {
      kind: WASTE_INCIDENT_BUS_KIND, lane: row.lane, projectedUnusedPct: pct, hoursToReset: hours,
      resetAt: row.reset_at, recommendedTarget: row.recommended_target, text: text.slice(0, 200),
    },
  };
}

export type WasteIncidentPost = { lane: string; status: BusInboxPost['status'] };

/** Best-effort: a throwing post is reported as 'unavailable' per lane and never escapes. */
export function postWasteIncidents(
  rows: readonly WasteRiskProjection[],
  nowMs: number,
  post: typeof appendBusInbox = appendBusInbox,
  options?: BusInboxOptions,
): WasteIncidentPost[] {
  return planWasteIncidents(rows).map(row => {
    try {
      return { lane: row.lane, status: post(buildWasteIncidentEnvelope(row, nowMs), options).status };
    } catch {
      return { lane: row.lane, status: 'unavailable' as const };
    }
  });
}
