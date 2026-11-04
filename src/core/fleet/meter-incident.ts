/** Flat-meter incident notices on the shared fleet bus. `fleet meter-drop`
 * proves a provider's meter stayed flat while its lane ran jobs; this turns
 * each such verdict into one 'meter-flat' P1 envelope per provider per clock
 * hour — the desktop bus view, the phone and agents already read the bus, and
 * the hour bucket inside the id makes reruns 'duplicate' instead of repeat
 * incidents. Verdicts other than 'flat_with_work' never raise an incident, so
 * missing evidence stays silent. */
import { appendBusInbox, type BusInboxOptions, type BusInboxPost } from './bus-inbox.js';
import type { BusEnvelope } from './bus-envelope.js';
import { fleetBusEventId } from './bus-mirror-dispatch.js';
import { CHANNEL_BUS_TTL_MS } from './channel-bus-publish.js';
import type { MeterDropProvider, MeterDropReport } from '../../cli/fleet-meter-drop.js';

export const METER_INCIDENT_BUS_KIND = 'meter-flat';
const HOUR_MS = 60 * 60 * 1000;

export interface MeterIncidentBody {
  kind: string;
  provider: string;
  running: number | null;
  /** Largest observed span across the provider's windows. */
  observedMinutes: number;
  /** Used-percent endpoints of that widest window. */
  firstUsedPercent: number | null;
  lastUsedPercent: number | null;
  text: string;
}

/** The widest proven span carries the incident's numbers; a window with no
 * comparable pair (observedMinutes null) never beats a provable one. */
function widestWindow(provider: MeterDropProvider): { minutes: number; first: number | null; last: number | null } {
  let best = { minutes: 0, first: null as number | null, last: null as number | null };
  for (const window of provider.windows) {
    if (window.observedMinutes !== null && window.observedMinutes > best.minutes) {
      best = { minutes: window.observedMinutes, first: window.firstUsedPercent, last: window.lastUsedPercent };
    }
  }
  return best;
}

export function buildMeterIncidentEnvelope(provider: MeterDropProvider, nowMs: number): BusEnvelope<MeterIncidentBody> {
  // Floored to the clock hour so a rerun inside the same hour builds the same
  // id and the inbox dedupes it rather than double-posting one incident.
  const hour = new Date(Math.floor(nowMs / HOUR_MS) * HOUR_MS).toISOString();
  const widest = widestWindow(provider);
  const running = provider.running ?? 0;
  const text = `${provider.provider} meter flat ${widest.minutes} min` +
    `${widest.last === null ? '' : ` at ${widest.last}%`} while ${running} job${running === 1 ? '' : 's'} run`;
  return {
    id: fleetBusEventId(METER_INCIDENT_BUS_KIND, hour, provider.provider),
    from: 'fleet', to: 'all', priority: 'P1', ttl: CHANNEL_BUS_TTL_MS,
    body: {
      kind: METER_INCIDENT_BUS_KIND, provider: provider.provider, running: provider.running,
      observedMinutes: widest.minutes, firstUsedPercent: widest.first, lastUsedPercent: widest.last,
      text: text.slice(0, 200),
    },
  };
}

export function planMeterIncidents(report: MeterDropReport): MeterDropProvider[] {
  return report.providers.filter(provider => provider.verdict === 'flat_with_work');
}

export type MeterIncidentPost = { provider: string; status: BusInboxPost['status'] };

/** Best-effort like the reset-release notice: a throwing post is reported as
 * 'unavailable' per provider and never escapes. */
export function postMeterIncidents(
  report: MeterDropReport,
  nowMs: number,
  post: typeof appendBusInbox = appendBusInbox,
  options?: BusInboxOptions,
): MeterIncidentPost[] {
  return planMeterIncidents(report).map(provider => {
    try {
      return { provider: provider.provider, status: post(buildMeterIncidentEnvelope(provider, nowMs), options).status };
    } catch {
      return { provider: provider.provider, status: 'unavailable' as const };
    }
  });
}
