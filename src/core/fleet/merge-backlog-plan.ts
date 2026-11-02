import {
  classifyFleetMergeStatePr,
  type FleetMergeStateRead,
  type FleetPrClassification,
  type FleetPrGhState,
} from './fleet-merge-state.js';

export interface MergeBacklogItem {
  /** Canonical owner/name; PR numbers are only unique within a repository. */
  repo: string;
  mergeState: FleetMergeStateRead;
  github: FleetPrGhState | null;
}

export interface MergeBacklogEntry extends MergeBacklogItem {
  classification: FleetPrClassification;
}

/**
 * Advisory snapshot, never merge or spending authority. Consumers must re-read
 * the exact head and pass existing merge/dispatch gates before acting. Recut
 * means replaying the proposal on the current base and verifying it anew.
 */
export function planMergeBacklog(
  items: readonly MergeBacklogItem[],
  limits: { merges: number; recuts: number },
): {
  merges: MergeBacklogEntry[];
  recuts: MergeBacklogEntry[];
  /** Clean branches requiring base refresh and fresh verification before landing. */
  refreshes: MergeBacklogEntry[];
  deferred: MergeBacklogEntry[];
  counts: { ready: number; conflicting: number; behind: number; repair: number; waiting: number };
} {
  for (const limit of [limits.merges, limits.recuts]) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('Backlog limits must be nonnegative safe integers');
  }
  const ready: MergeBacklogEntry[] = [];
  const recut: MergeBacklogEntry[] = [];
  const deferred: MergeBacklogEntry[] = [];
  const refreshes: MergeBacklogEntry[] = [];
  const counts = { ready: 0, conflicting: 0, behind: 0, repair: 0, waiting: 0 };
  // Ambiguous duplicate observations must not authorize either action.
  const identities = new Map<string, number>();
  const identity = (item: MergeBacklogItem): string => `${item.repo.toLowerCase()}#${item.github?.number ?? '?'}`;
  for (const item of items) identities.set(identity(item), (identities.get(identity(item)) ?? 0) + 1);
  for (const item of items) {
    const classification: FleetPrClassification = identities.get(identity(item)) !== 1
      ? { class: 'unknown', work: 'none', reason: 'duplicate-pr-observation' }
      : classifyFleetMergeStatePr(item.mergeState, item.github);
    const entry = { ...item, classification };
    switch (classification.class) {
      case 'green-ready': counts.ready++; ready.push(entry); break;
      case 'conflicted': counts.conflicting++; recut.push(entry); break;
      case 'behind': counts.behind++; refreshes.push(entry); break;
      case 'red-required': counts.repair++; deferred.push(entry); break;
      default: counts.waiting++; deferred.push(entry);
    }
  }
  // Independent limits are load-bearing: even an arbitrarily long conflict
  // prefix cannot spend a ready merge slot. Preserve input order within lanes.
  return {
    merges: ready.slice(0, limits.merges),
    recuts: recut.slice(0, limits.recuts),
    refreshes,
    deferred: [...ready.slice(limits.merges), ...recut.slice(limits.recuts), ...deferred],
    counts,
  };
}
