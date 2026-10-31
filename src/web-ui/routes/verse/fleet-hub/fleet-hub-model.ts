import type { FleetRuns } from '../ops/ops-runs-model.js';

const panes = [
  ['fleet-lanes', 'Lanes'], ['fleet-events', 'Fleet events'],
  ['fleet-inbox', 'Inbox'], ['fleet-bus', 'Bus'],
  ['fleet-merges', 'Merges'], ['fleet-usage', 'Usage'],
  ['fleet-supply', 'Supply'], ['fleet-host', 'Host'], ['fleet-timeline', 'Timeline'],
] as const;

/** Stable tile order and readings; registration is supplied by the caller. */
export function hubTiles(runs: FleetRuns | null, registeredIds: readonly string[]) {
  const counts: Record<string, string> = runs ? {
    'fleet-lanes': `${runs.lanes.reduce((n, lane) => n + lane.running, 0)}/${runs.lanes.reduce((n, lane) => n + lane.target, 0)}`,
    'fleet-events': String(runs.events.length),
    'fleet-inbox': String(runs.inbox.length),
    'fleet-merges': String(runs.mergesLastHour.count ?? '—'),
    'fleet-supply': String(runs.workers.length),
  } : {};
  return panes.map(([id, title]) => ({ id, title, count: counts[id] ?? '—', present: registeredIds.includes(id) }));
}
