import type { AgentBusReceipt } from '../fleet-bus/agent-bus-queries.js';
import type { FleetNeedsYouItem } from './fleet-needs-you.js';

/** Mirrors the waste-high body kind posted by core/fleet/waste-incident.ts (the web bundle takes no core imports). */
const WASTE_HIGH_KIND = 'waste-high';
const TITLE_MAX = 120;
const URGENT_HOURS = 6;

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** One Needs-you row per lane projected to leave included capacity unused at reset; observations only. */
export function deriveWasteHighNeedsYou(envelopes: readonly AgentBusReceipt[] | null | undefined, nowMs: number): FleetNeedsYouItem[] {
  const newest = new Map<string, { at: number; item: FleetNeedsYouItem }>();
  for (const { receivedAt, envelope } of envelopes ?? []) {
    const body = envelope.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) continue;
    const b = body as Record<string, unknown>;
    if (b.kind !== WASTE_HIGH_KIND || typeof b.lane !== 'string' || !b.lane || typeof b.text !== 'string'
      || !finite(b.projectedUnusedPct) || !finite(b.hoursToReset)) continue;
    if (receivedAt + envelope.ttl <= nowMs) continue;
    const item: FleetNeedsYouItem = {
      id: `waste-high:${b.lane}`,
      severity: b.hoursToReset <= URGENT_HOURS ? 'urgent' : 'attention',
      title: b.text.slice(0, TITLE_MAX),
      detail: `${b.projectedUnusedPct}% unused at reset · ${b.hoursToReset} h left${finite(b.recommendedTarget) ? ` · suggested target ${b.recommendedTarget}` : ''}`,
      nextStep: "Raise this lane's target or add jobs for it",
      target: 'fleet', open: { kind: 'pane', paneId: 'fleet-lanes', lane: b.lane },
    };
    if (receivedAt >= (newest.get(b.lane)?.at ?? -Infinity)) newest.set(b.lane, { at: receivedAt, item });
  }
  return [...newest.values()].map(entry => entry.item);
}
