import type { FleetRunsLane } from './runs-queries.js';

export interface WaitingRuns {
  lanes: FleetRunsLane[];
  drop: { pending: Array<{ lane: string; file: string }> } | null;
}

export function waitingView(runs: WaitingRuns, _nowMs: number) {
  const waiting = runs.lanes.filter((lane) => (lane.queued ?? 0) > 0 || lane.held);
  const queued = waiting.filter((lane) => (lane.queued ?? 0) > 0);
  const stalled = queued.filter((lane) => lane.running !== null && lane.target !== null && lane.running < lane.target);
  const rows = waiting.map((lane) => {
    const count = (value: number | null) => value === null ? '—' : String(value);
    const badge = lane.held ? `Held: ${lane.heldReason || 'reason unavailable'}`
      : lane.running === null || lane.target === null ? 'Capacity unknown'
      : lane.running >= lane.target ? 'Full' : `Open slots: ${lane.target - lane.running}`;
    return {
      key: `lane:${lane.lane}`,
      title: `${lane.lane} · ${count(lane.queued)} queued · running ${count(lane.running)} of ${count(lane.target)}`,
      subtitle: undefined as string | undefined,
      badge,
      tone: lane.held ? 'warning' as const : badge.startsWith('Open slots:') ? 'success' as const : 'neutral' as const,
    };
  });
  if (runs.drop && runs.drop.pending.length > 0) {
    rows.push({ key: 'drop', title: `${runs.drop.pending.length} jobs in the drop folder`,
      subtitle: [...new Set(runs.drop.pending.map((job) => job.lane))].join(', '), badge: '', tone: 'neutral' });
  }
  const verdict = rows.length === 0 ? 'Nothing waiting'
    : stalled.length ? `Launch stall: ${stalled.map((lane) => lane.lane).join(', ')} have open slots and queued work`
    : queued.length && queued.every((lane) => lane.held) ? 'Waiting on held lanes'
    : queued.some((lane) => lane.running === null || lane.target === null) ? 'Waiting for lane status'
    : queued.length ? 'Queued behind full lanes'
    : waiting.length ? 'Waiting on held lanes' : 'Waiting in the drop folder';
  return { rows, verdict };
}
