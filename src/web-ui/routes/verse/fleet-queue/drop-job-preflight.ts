import type { MergeBacklogReadV1 } from '../../../../core/fleet/merge-backlog-read.js';
import type { LaneTargetsV1 } from '../ops/lane-targets-model.js';

type LaneWithCounts = LaneTargetsV1['lanes'][number] & { running?: number; queued?: number };
export type PreflightTargets = Omit<LaneTargetsV1, 'lanes'> & { lanes: LaneWithCounts[] };

export function extractPaths(body: string): string[] {
  const paths = new Set<string>();
  for (const match of body.matchAll(/(?:src|test|docs|scripts)\/[A-Za-z0-9_./-]+\.(?:tsx|ts|md|mjs|json)\b/g)) {
    paths.add(match[0]);
    if (paths.size === 40) break;
  }
  return [...paths];
}

export function hotFileWarnings(paths: readonly string[], backlog: MergeBacklogReadV1 | null | undefined) {
  if (!backlog || backlog.source !== 'ok') return [];
  return paths.flatMap(path => {
    const items = backlog.items.filter(item => item.files?.includes(path));
    const hot = backlog.hotFiles?.find(file => file.path === path);
    if (!hot && !items.length) return [];
    return [{ path, dirtyPrs: hot?.dirtyPrs ?? items.filter(item => item.mergeStateStatus === 'DIRTY').length,
      prNumbers: items.slice(0, 5).map(item => item.number) }];
  }).sort((a, b) => b.dirtyPrs - a.dirtyPrs);
}

function freeSlots(row: LaneWithCounts): number | null {
  if (typeof row.running !== 'number' || !Number.isFinite(row.running) || row.running < 0) return row.target === 0 ? 0 : null;
  return Math.max(0, row.target - row.running);
}

export function laneLine(lane: string, targets: PreflightTargets | null | undefined, nowMs: number): string | null {
  if (!targets || targets.sourceState !== 'healthy') return null;
  const row = targets.lanes.find(item => item.lane === lane);
  if (!row) return null;
  const free = freeSlots(row);
  let line: string;
  if (row.held) {
    const expiry = row.heldUntil ? new Date(row.heldUntil) : null;
    const time = expiry && Number.isFinite(expiry.getTime()) && expiry.getTime() > nowMs
      ? ` until ${String(expiry.getHours()).padStart(2, '0')}:${String(expiry.getMinutes()).padStart(2, '0')}` : '';
    line = `${lane} is held${time}${row.heldReason ? ` (${row.heldReason})` : ''}`;
  } else {
    if (free === null) return null;
    line = row.running === undefined ? `${lane} has no free slots`
      : `${lane}: ${row.running} of ${row.target} running${typeof row.queued === 'number' && Number.isFinite(row.queued) && row.queued >= 0 ? `, ${row.queued} waiting` : ''}`;
  }
  if (row.held || free === 0) {
    const alternative = targets.lanes.filter(item => item.lane !== lane && !item.held && (freeSlots(item) ?? 0) > 0)
      .sort((a, b) => (freeSlots(b) ?? 0) - (freeSlots(a) ?? 0) || a.lane.localeCompare(b.lane))[0];
    if (alternative) {
      const slots = freeSlots(alternative)!;
      line += `; ${alternative.lane} has ${slots} free ${slots === 1 ? 'slot' : 'slots'}`;
    }
  }
  return line;
}
