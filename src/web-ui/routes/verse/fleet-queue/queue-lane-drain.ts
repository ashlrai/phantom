import { queueDrainEta } from '../fleet/queue-drain-eta.js';

export function laneDrainText(
  row: { lane: string; ready: number },
  snapshotLane: { running: number; target: number; held: boolean } | undefined,
): string | null {
  if (!snapshotLane) return null;
  const estimate = queueDrainEta({ ...snapshotLane, queued: row.ready });
  if (estimate.state === 'held') return 'held · nothing drains';
  if (estimate.state === 'idle') return `idle · ${estimate.freeSlots} free slots`;
  if (estimate.state === 'saturated') return 'saturated · 0 free';
  if (estimate.drainMinutes === null) return null;
  const minutes = estimate.drainMinutes > 10
    ? Math.round(estimate.drainMinutes / 5) * 5
    : Math.round(estimate.drainMinutes);
  return `drains in ~${minutes} min · ${estimate.freeSlotsAtNextPass} free at next pass`;
}
