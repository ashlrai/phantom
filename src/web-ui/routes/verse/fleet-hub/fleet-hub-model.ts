import type { FleetRuns } from '../ops/ops-runs-model.js';

const panes = [
  ['fleet-lanes', 'Lanes'], ['fleet-events', 'Fleet events'],
  ['fleet-inbox', 'Inbox'], ['fleet-bus', 'Bus'],
  ['fleet-merges', 'Merges'], ['fleet-usage', 'Usage'],
  ['fleet-supply', 'Supply'], ['fleet-host', 'Host'], ['fleet-timeline', 'Timeline'],
] as const;

export const CURATED_FLEET_WORKSPACE = ['fleet-lanes', 'fleet-inbox', 'fleet-merges', 'fleet-bus', 'fleet-releases', 'fleet-usage'] as const;

/** Tile count string: appends "· N held" when any lane has `held === true`. */
export function lanesTileCount(lanes: { running: number; target: number; held: boolean }[]) {
  const running = lanes.reduce((n, lane) => n + lane.running, 0);
  const target = lanes.reduce((n, lane) => n + lane.target, 0);
  const held = lanes.filter((lane) => lane.held).length;
  return held > 0 ? `${running}/${target} · ${held} held` : `${running}/${target}`;
}

export function curatedWorkspace(presentIds: readonly string[]) {
  return CURATED_FLEET_WORKSPACE.filter((id) => presentIds.includes(id));
}

/** Stable tile order and readings; registration is supplied by the caller. */
export function hubTiles(runs: FleetRuns | null, registered: readonly { id: string; title: string; description?: string | null; order?: number }[]) {
  const counts: Record<string, string> = runs ? {
    'fleet-lanes': lanesTileCount(runs.lanes),
    'fleet-events': String(runs.events.length),
    'fleet-inbox': String(runs.inbox.length),
    'fleet-merges': String(runs.mergesLastHour.count ?? '—'),
    'fleet-supply': String(runs.workers.length),
    'fleet-job-log': String(runs.workers.length),
    'worker-log': String(runs.workers.length),
    'leader-thread': String(runs.leaders.length),
    'fleet-channels': String(new Set(runs.inbox.map((item) => item.source)).size),
  } : {};
  const byId = new Map(registered.map((pane) => [pane.id, pane]));
  const legacyIds = new Set<string>(panes.map(([id]) => id));
  const discovered = [...byId.values()]
    // The job-log pane predates the fleet prefix and registers as worker-log.
    .filter(({ id }) => !legacyIds.has(id) && (id.startsWith('fleet-') || id.startsWith('leader-') || id === 'worker-log'))
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.title.localeCompare(b.title));
  return [
    ...panes.map(([id, title]) => ({ id, title: byId.get(id)?.title ?? title, count: counts[id] ?? '—', present: byId.has(id) })),
    ...discovered.map(({ id, title }) => ({ id, title, count: counts[id] ?? '—', present: true })),
  ];
}
