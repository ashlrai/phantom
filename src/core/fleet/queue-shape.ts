import type { FleetLaneQueueRow } from './lane-console.js';

export interface QueueShapeTargetRow {
  lane: string;
  target: number;
  held: boolean;
}

export interface QueueShapeRepo {
  repo: string;
  ready: number;
  /** Fraction of the lane's READY rows attributed to this repo (0-1). */
  share: number;
}

export interface QueueShapeLane {
  lane: string;
  ready: number;
  /** Slot target for the lane; null when the targets source has no row for it. */
  target: number | null;
  /** ready / target; null when the lane has no target or the target is 0. */
  ratio: number | null;
  /** Over the depth bound: ratio above overDeepFactor, or target 0 with ready rows. */
  overDeep: boolean;
  held: boolean;
  topRepos: QueueShapeRepo[];
  /** Age in seconds of the oldest READY row with a usable `at`; null when none has one. */
  oldestReadyAgeSeconds: number | null;
  /** READY rows with no usable `at` (missing, unparseable or in the future); counted in `ready`, not in the age. */
  untimedReady: number;
}

export interface QueueShapeReport {
  v: 1;
  totalReady: number;
  totalTarget: number;
  lanes: QueueShapeLane[];
  /** Lane ids flagged overDeep, in report order. */
  overDeep: string[];
}

export interface QueueShapeOptions {
  /** ready/target above which a lane is over-deep. Default 3. */
  overDeepFactor?: number;
  /** Repos listed per lane. Default 3. */
  topRepos?: number;
  /** Epoch ms that ages are measured from. Without it every lane reports a null age. */
  now?: number;
}

const DEFAULT_FACTOR = 3;
const DEFAULT_TOP_REPOS = 3;
const NO_REPO = '(none)';

/**
 * Fold ready.tsv rows and lane slot targets into a per-lane depth report:
 * how deep each lane's READY queue is against its target, and which repos
 * fill it. Pure — no I/O, no clock, never throws.
 */
export function queueShape(
  rows: readonly FleetLaneQueueRow[],
  targets: readonly QueueShapeTargetRow[],
  opts: QueueShapeOptions = {},
): QueueShapeReport {
  const factor = typeof opts.overDeepFactor === 'number' && Number.isFinite(opts.overDeepFactor) && opts.overDeepFactor > 0
    ? opts.overDeepFactor : DEFAULT_FACTOR;
  const topN = Number.isSafeInteger(opts.topRepos) && opts.topRepos! >= 0 ? opts.topRepos! : DEFAULT_TOP_REPOS;
  const now = typeof opts.now === 'number' && Number.isFinite(opts.now) ? opts.now : null;

  const readyRows = new Map<string, FleetLaneQueueRow[]>();
  for (const row of rows) {
    if (row.status !== 'READY' || typeof row.pool !== 'string' || row.pool === '') continue;
    const list = readyRows.get(row.pool) ?? [];
    list.push(row);
    readyRows.set(row.pool, list);
  }
  const targetRows = new Map<string, QueueShapeTargetRow>();
  for (const row of targets) if (typeof row.lane === 'string' && row.lane !== '') targetRows.set(row.lane, row);

  const lanes: QueueShapeLane[] = [];
  for (const lane of new Set([...readyRows.keys(), ...targetRows.keys()])) {
    const queue = readyRows.get(lane) ?? [];
    const target = targetRows.get(lane);
    const ready = queue.length;
    const ratio = target === undefined || target.target === 0 ? null : ready / target.target;
    const overDeep = target !== undefined && (target.target === 0 ? ready > 0 : ready / target.target > factor);
    const counts = new Map<string, number>();
    for (const row of queue) {
      const repo = typeof row.repo === 'string' && row.repo !== '' ? row.repo : NO_REPO;
      counts.set(repo, (counts.get(repo) ?? 0) + 1);
    }
    const topRepos = [...counts]
      .map(([repo, count]) => ({ repo, ready: count, share: ready === 0 ? 0 : count / ready }))
      .sort((a, b) => b.ready - a.ready || a.repo.localeCompare(b.repo))
      .slice(0, topN);
    // Oldest = smallest `at`. A row whose time cannot be trusted is counted as untimed, never guessed.
    let oldestAt: number | null = null, untimedReady = 0;
    for (const row of queue) {
      const at = Date.parse(row.at ?? '');
      if (now === null || !Number.isFinite(at) || at > now) untimedReady++;
      else oldestAt = oldestAt === null ? at : Math.min(oldestAt, at);
    }
    const oldestReadyAgeSeconds = oldestAt === null || now === null ? null : Math.floor((now - oldestAt) / 1000);
    lanes.push({
      lane, ready, target: target?.target ?? null, ratio, overDeep, held: target?.held ?? false, topRepos,
      oldestReadyAgeSeconds, untimedReady,
    });
  }
  lanes.sort((a, b) => Number(b.overDeep) - Number(a.overDeep) || b.ready - a.ready || a.lane.localeCompare(b.lane));
  return {
    v: 1,
    totalReady: lanes.reduce((sum, lane) => sum + lane.ready, 0),
    totalTarget: lanes.reduce((sum, lane) => sum + (lane.target ?? 0), 0),
    lanes,
    overDeep: lanes.filter(lane => lane.overDeep).map(lane => lane.lane),
  };
}
