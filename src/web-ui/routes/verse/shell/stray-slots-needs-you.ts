import type { StraySlotsV1 } from '../../../../core/fleet/stray-slots.js';
import type { FleetNeedsYouItem } from './fleet-needs-you.js';

/** Observations only; the existing Lanes controls re-check each process. */
export function deriveStraySlotsNeedsYou(report: StraySlotsV1 | null | undefined, nowMs: number): FleetNeedsYouItem[] {
  void nowMs;
  if (report?.source !== 'ok') return [];
  const lanes = report.lanes.filter(lane => lane.slotsLost > 0);
  const total = lanes.reduce((sum, lane) => sum + lane.slotsLost, 0);
  if (!total) return [];
  return [{
    id: 'stray-slots', severity: total >= 3 ? 'urgent' : 'attention',
    title: `${total} lane ${total === 1 ? 'slot' : 'slots'} lost to leftover processes`,
    detail: lanes.map(lane => `${lane.lane}: ${lane.slotsLost}`).join(' · '),
    nextStep: 'Stop them (each is re-checked before SIGTERM)',
    target: 'fleet', open: { kind: 'pane', paneId: 'fleet-lanes' },
  }];
}
