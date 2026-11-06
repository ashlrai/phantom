import type { QueryDef } from '../../../data/queries.js';
import { agentBusPageQuery, agentBusStatusQuery, type AgentBusReceipt } from '../fleet-bus/agent-bus-queries.js';
import type { FleetNeedsYouItem } from './fleet-needs-you.js';

/** Mirrors METER_INCIDENT_BUS_KIND in core/fleet/meter-incident.ts (the web bundle takes no core imports). */
const METER_FLAT_KIND = 'meter-flat';
const TITLE_MAX = 120;
const URGENT_MINUTES = 60;

/** The same newest-100 window the rail chip reads; reuses the bus routes, adds none. */
export const meterFlatBusQuery: QueryDef<AgentBusReceipt[]> = {
  key: 'verse-meter-flat-bus',
  fetch: async signal => {
    const status = await agentBusStatusQuery.fetch(signal);
    if (status?.source !== 'available' || status.retainedCount === null) return [];
    const page = await agentBusPageQuery(Math.max(0, status.retainedCount - 100), 100).fetch(signal);
    const now = Date.now();
    // The API reports remaining TTL; the derive below wants it counted from receipt (as the bus page store does).
    return (page?.messages ?? []).map(row => ({ ...row, envelope: { ...row.envelope,
      ttl: Math.min(Number.MAX_SAFE_INTEGER, row.envelope.ttl + Math.max(0, now - row.receivedAt)) } }));
  },
};

const percent = (x: unknown) => typeof x === 'number' && Number.isFinite(x) ? x : null;

/** One Needs-you row per provider whose meter is flat while its lane runs jobs; observations only. */
export function deriveMeterFlatNeedsYou(envelopes: readonly AgentBusReceipt[] | null | undefined, nowMs: number): FleetNeedsYouItem[] {
  const newest = new Map<string, { at: number; item: FleetNeedsYouItem }>();
  for (const { receivedAt, envelope } of envelopes ?? []) {
    const body = envelope.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) continue;
    const b = body as Record<string, unknown>;
    if (b.kind !== METER_FLAT_KIND || typeof b.provider !== 'string' || !b.provider
      || typeof b.text !== 'string' || typeof b.observedMinutes !== 'number' || !Number.isFinite(b.observedMinutes)) continue;
    if (receivedAt + envelope.ttl <= nowMs) continue;
    const first = percent(b.firstUsedPercent);
    const last = percent(b.lastUsedPercent);
    const item: FleetNeedsYouItem = {
      id: `meter-flat:${b.provider}`,
      severity: b.observedMinutes >= URGENT_MINUTES ? 'urgent' : 'attention',
      title: b.text.slice(0, TITLE_MAX),
      detail: `${first !== null && last !== null ? `used ${first}% → ${last}% ` : ''}over ${b.observedMinutes} min`,
      nextStep: 'Check the lane is really spending, or hold it',
      target: 'fleet', open: { kind: 'pane', paneId: 'fleet-lanes', lane: b.provider },
    };
    if (receivedAt >= (newest.get(b.provider)?.at ?? -Infinity)) newest.set(b.provider, { at: receivedAt, item });
  }
  return [...newest.values()].map(entry => entry.item);
}
