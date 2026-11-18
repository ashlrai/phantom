/** Read-only compute/session join. No dispatch, worktree traversal or remote log reads. */
import { readFleetCompute, type FleetCompute } from './compute-view.js';
import { getFleetSessions, type FleetSessionsV1, type FleetSessionV1 } from './runs-sessions.js';
import { getFleetJobDetail, type FleetJobDetailV1 } from './runs-job-detail.js';

export type SessionMapState = 'running' | 'idle' | 'held' | 'queued' | 'unknown';
export interface MapSession extends Pick<FleetSessionV1, 'job' | 'lane' | 'model' | 'elapsedSeconds' | 'prUrl' | 'outcome'> {
  status: FleetSessionV1['status'] | 'unknown';
  nodeId: string | null;
  placement: 'claim' | 'process' | 'conflict' | 'unknown';
  mapState: SessionMapState;
  branch: string | null;
  worktree: 'recorded' | null;
  activity: string | null;
  detailSources: FleetJobDetailV1['sources'] | null;
}
export interface FleetSessionMap extends FleetSessionsV1 {
  computeAt: string;
  /** The compute node id of the computer that answered (compute-view's `localNodeId`). */
  localNodeId: string;
  mapSessions: MapSession[];
  mapRecent: MapSession[];
}
export const sessionMapState = (status: MapSession['status']): SessionMapState =>
  status === 'queued' ? 'queued' : status === 'parked' ? 'held' : status === 'exited' ? 'idle' :
    ['running', 'launching', 'publishing'].includes(status) ? 'running' : 'unknown';

export function mapSession(row: Pick<FleetSessionV1, 'job' | 'lane' | 'model' | 'elapsedSeconds' | 'prUrl' | 'outcome'> &
  { status: MapSession['status']; live?: FleetSessionV1['live'] }, compute: FleetCompute): MapSession {
  const claims = compute.nodes.filter(n => n.jobs.some(j => j.job === row.job));
  const conflict = claims.length > 1 || (row.live === 'yes' && claims.length === 1 && !claims[0]!.local);
  const claim = !conflict ? claims[0] : undefined;
  const process = row.live === 'yes' && !['queued', 'parked', 'finished', 'stale'].includes(row.status);
  return { job: row.job, lane: row.lane, model: row.model, status: row.status, elapsedSeconds: row.elapsedSeconds,
    prUrl: row.prUrl, outcome: row.outcome, nodeId: conflict ? null : claim?.id ?? (process ? compute.localNodeId : null),
    placement: conflict ? 'conflict' : claim ? 'claim' : process ? 'process' : 'unknown', mapState: sessionMapState(row.status),
    branch: null, worktree: null, activity: null, detailSources: null };
}

/** Bounds: 100 local details, eight readers at a time, existing readers' byte/symlink guards. */
export async function readFleetSessionMap(options: {
  compute?: FleetCompute; sessions?: FleetSessionsV1; runsDir?: string; now?: number;
  readDetail?: typeof getFleetJobDetail;
} = {}): Promise<FleetSessionMap> {
  const now = options.now ?? Date.now();
  const [compute, inventory] = await Promise.all([
    options.compute ?? readFleetCompute({ runsDir: options.runsDir, now }),
    options.sessions ?? getFleetSessions({ runsDir: options.runsDir, now: () => now }),
  ]);
  const sessions = inventory.sessions.map(s => mapSession(s, compute));
  // A new active attempt wins over an older terminal row with the same job id.
  const activeIds = new Set(sessions.map(s => s.job));
  const recent = inventory.recent.filter(s => !activeIds.has(s.job)).map(s => mapSession(s, compute));
  // Terminal receipts must not be shadowed by a stale node claim.
  const seen = new Set([...sessions, ...recent].map(s => s.job));
  let truncated = inventory.truncated || compute.truncated;
  for (const node of compute.nodes) for (const claim of node.jobs) {
    if (seen.has(claim.job)) continue;
    if (sessions.length >= 500) { truncated = true; continue; }
    seen.add(claim.job);
    sessions.push(mapSession({ job: claim.job, lane: null, model: null, status: 'unknown',
      elapsedSeconds: null, prUrl: null, outcome: null }, compute));
  }
  // Only this host's dispatch inventory has local artifacts. Claim-only jobs and
  // ambiguous/remote placements must never inherit this host's similarly named files.
  const localJobs = new Set(inventory.sessions.map(s => s.job));
  // Recent artifacts are read only with an explicit claim on this host;
  // an unplaced or remote historical row cannot establish local ownership.
  const localRecent = recent.filter(s => s.placement === 'claim' && s.nodeId === compute.localNodeId);
  const candidates = [...sessions.filter(s => localJobs.has(s.job)), ...localRecent].filter(s => s.placement !== 'conflict' &&
    (s.nodeId === null || s.nodeId === compute.localNodeId) && !['queued', 'parked'].includes(s.status));
  if (candidates.length > 100) truncated = true;
  const pending = candidates.slice(0, 100);
  await Promise.all(Array.from({ length: Math.min(8, pending.length) }, async () => {
    for (let row = pending.pop(); row; row = pending.pop()) {
      try {
        const detail = await (options.readDetail ?? getFleetJobDetail)(row.job, {
          runsDir: options.runsDir, now: () => new Date(now), maxTailLines: 1, maxTailBytes: 4096,
        });
        row.branch = detail.branch;
        row.worktree = detail.branch === null ? null : 'recorded';
        row.activity = detail.log.tail.filter(line => line.trim()).at(-1)?.slice(0, 160) ?? null;
        row.prUrl = detail.publish?.prUrl ?? row.prUrl;
        row.detailSources = detail.sources;
      } catch { /* absent/invalid per-job evidence remains explicitly unknown */ }
    }
  }));
  return { ...inventory, computeAt: compute.generatedAt, localNodeId: compute.localNodeId, mapSessions: sessions, mapRecent: recent, truncated };
}
