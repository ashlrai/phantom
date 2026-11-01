import { relativeText, type FleetRuns } from '../ops/ops-runs-model.js';

const panes = [
  ['fleet-lanes', 'Lanes'], ['fleet-events', 'Fleet events'],
  ['fleet-inbox', 'Inbox'], ['fleet-bus', 'Bus'],
  ['fleet-merges', 'Merges'], ['fleet-usage', 'Usage'],
  ['fleet-supply', 'Supply'], ['fleet-host', 'Host'], ['fleet-timeline', 'Timeline'],
] as const;

export const CURATED_FLEET_WORKSPACE = ['fleet-lanes', 'fleet-inbox', 'fleet-merges', 'fleet-bus', 'fleet-releases', 'fleet-usage'] as const;

export function hubEmptyState(runs: FleetRuns | null): { kind: 'no-fleet' | 'not-landed' } | null {
  if (runs === null || runs.sources.runsDir === 'not-landed') return { kind: 'not-landed' };
  return runs.sources.runsDir === 'missing' ? { kind: 'no-fleet' } : null;
}

/** Tile count string: appends "· N held" when any lane has `held === true`. */
export function lanesTileCount(lanes: { running: number; target: number; held: boolean }[]) {
  const running = lanes.reduce((n, lane) => n + lane.running, 0);
  const target = lanes.reduce((n, lane) => n + lane.target, 0);
  const held = lanes.filter((lane) => lane.held).length;
  return held > 0 ? `${running}/${target} · ${held} held` : `${running}/${target}`;
}

/** Host tile count: disk free to one decimal, plus free memory percent when known. */
function hostTileCount(runs: FleetRuns) {
  if (runs.diskFreeGb === null) return '—';
  return `${runs.diskFreeGb.toFixed(1)} GB free${runs.memFreePct === null ? '' : ` · ${runs.memFreePct}% mem`}`;
}

/** Dispatch tile count: free lane slots, "all held" when every lane is held. */
function dispatchTileCount(lanes: { running: number; target: number; held: boolean }[]) {
  if (lanes.length === 0) return '—';
  if (lanes.every((lane) => lane.held)) return 'all held';
  const free = lanes.reduce((n, lane) => n + (lane.held ? 0 : Math.max(0, lane.target - lane.running)), 0);
  return `${free} free`;
}

/** Age of the /api/fleet/runs snapshot for the hub header. */
export function snapshotAge(generatedAt: string | null, nowMs: number): string {
  const at = generatedAt === null ? NaN : Date.parse(generatedAt);
  if (!Number.isFinite(at)) return 'reading not timed';
  const seconds = Math.floor((nowMs - at) / 1_000);
  if (seconds < 10) return 'read just now';
  if (seconds < 60) return `read ${seconds}s ago`;
  return `read ${relativeText(generatedAt, nowMs)}`;
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
    'fleet-usage': runs.codexPersonal?.usedPct != null ? `${Math.round(runs.codexPersonal.usedPct)}% personal` : '—',
    'fleet-host': hostTileCount(runs),
    'fleet-timeline': runs.events.length > 0 ? `${runs.events.length} events` : '—',
    'fleet-dispatch': dispatchTileCount(runs.lanes),
    'fleet-releases': runs.publishesLastHour.length > 0 ? `${runs.publishesLastHour.length} publishes/h` : '—',
    'fleet-decisions': runs.drop !== null && runs.drop.pending.length > 0 ? `${runs.drop.pending.length} in drop` : '—',
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
