/**
 * area-outcomes.ts — per-backlog-area merge/revert outcomes.
 *
 * cloud/backlog.ts orders the self-improvement backlog by measured metric
 * leverage (kindLeverage over improve/outcomes.jsonl), but that ledger only
 * ever sees proposals whose item declares a deterministic `metric` — a
 * small minority of discovered items. For every other area the leverage
 * map answers "unmeasured" forever, so the pick order cannot tell an area
 * whose PRs keep landing and holding from one whose fixes keep being
 * reverted. This fold supplies that missing signal from evidence that
 * already exists off-repo: the same checkout-free post-merge fold
 * observe-sync.ts runs on the scheduler tick
 * (outcomeObservationEvidence — merged task outcomes, fleet merge-state
 * landing records and the revert-outcomes journal), joined back to backlog
 * items through `backlogItemId`.
 *
 * One outcome per item: the newest task WITH resolved carrier evidence
 * decides, so a retry that is still in flight never erases the verdict of
 * the attempt before it, and a re-landed merge counts as held (the change
 * stands again), matching scoreOutcomes' re-land rule.
 *
 * Honesty rules:
 *  - Read-only and bounded: the revert journal is read through
 *    readRevertOutcomeRecords (verified prefix, 'unreadable' contributes
 *    nothing — same rule observe-sync applies) and fleet merge state
 *    through readFleetMergeState per superseded task.
 *  - Fail-closed: any thrown read yields an empty map — no evidence, no
 *    reordering, never a stall.
 *  - Unknown stays unknown: an item whose carrier PR has no merge or
 *    revert evidence contributes nothing; PRs still open or tasks without
 *    a PR are skipped, not counted as failures.
 *  - Areas, not items: cells key on kindOf(item.area), the same
 *    normalization the leverage map uses, so both signals group alike.
 */
import type { CloudIntakeMemo, CloudSupersededBy, CloudTaskPr, CloudTaskState } from '../cloud/types.js';
import { readFleetMergeState, type FleetMergeStateRead } from '../fleet/fleet-merge-state.js';
import { kindOf } from './outcomes.js';
import { prKey } from './lesson-trial.js';
import { outcomeObservationEvidence, type OutcomeObservationTask } from './observe-sync.js';
import { readRevertOutcomeRecords, type RevertLedgerRead } from './revert-ledger.js';
import type { RevertOutcomeRecord } from './reverted.js';

/** Merge/revert outcome counts for one backlog area kind. */
export interface AreaOutcomeCell {
  /** Items whose newest resolved carrier PR merged and still stands (a re-land counts as held). */
  held: number;
  /** Items whose newest resolved carrier PR has a standing revert. */
  reverted: number;
}

/**
 * The slice of a delivery-lane task this fold reads. Every field is
 * optional so a narrowed claim view (cloud/backlog.ts BacklogClaimTask)
 * and both full task shapes (CloudTaskV1, DevinTaskV1) are accepted;
 * tasks missing repo/state/pr simply contribute no evidence.
 */
export interface AreaOutcomeTask {
  /** Backlog item this task worked; absent/null = not self-improvement work. */
  backlogItemId?: string | null;
  /** Task creation time; orders retries of the same item (newest resolved wins). */
  createdAt?: string;
  repo?: string;
  state?: CloudTaskState | 'blocked';
  pr?: CloudTaskPr | null;
  supersededBy?: CloudSupersededBy | null;
  intake?: CloudIntakeMemo | null;
  outcome?: { mergeSha?: unknown; revertedBy?: unknown } | null;
}

export interface BacklogAreaOutcomeDeps {
  /** Revert-outcomes journal read; defaults to readRevertOutcomeRecords. */
  reverts?: () => RevertLedgerRead;
  /** Fleet merge-state read by state key; defaults to readFleetMergeState. */
  fleetState?: (key: string) => FleetMergeStateRead;
}

/**
 * Fold backlog-carrying tasks into per-area {held, reverted} cells. `items`
 * supplies the id → area join (pass the same list the ordering sees —
 * built-ins plus user items). Returns an empty map when no task carries
 * resolvable post-merge evidence.
 */
export function backlogAreaOutcomes(
  tasks: readonly AreaOutcomeTask[],
  items: readonly { id: string; area: string }[],
  deps: BacklogAreaOutcomeDeps = {},
): Map<string, AreaOutcomeCell> {
  const cells = new Map<string, AreaOutcomeCell>();
  const byId = new Map<string, { id: string; area: string }>();
  for (const item of items) if (!byId.has(item.id)) byId.set(item.id, item);
  const byItem = new Map<string, AreaOutcomeTask[]>();
  for (const task of tasks) {
    const id = task.backlogItemId;
    if (typeof id !== 'string' || !byId.has(id)) continue;
    byItem.set(id, [...(byItem.get(id) ?? []), task]);
  }
  if (byItem.size === 0) return cells;

  // Only fully-identified tasks can carry carrier evidence; the rest are
  // skipped before the shared fold ever sees them.
  const observed: OutcomeObservationTask[] = [];
  for (const task of tasks) {
    if (typeof task.repo !== 'string' || task.repo === '' || task.state === undefined) continue;
    observed.push({
      repo: task.repo,
      state: task.state,
      pr: task.pr ?? null,
      supersededBy: task.supersededBy ?? null,
      intake: task.intake ?? null,
      outcome: task.outcome ?? null,
    });
  }

  let evidence: ReturnType<typeof outcomeObservationEvidence>;
  try {
    const revertRead = (deps.reverts ?? readRevertOutcomeRecords)();
    const fleetState = deps.fleetState ?? readFleetMergeState;
    // An unreadable revert journal contributes no journal evidence — the
    // same fail-closed rule observe-sync applies (its verified prefix can
    // be staler than the task fields it would override).
    const records: readonly RevertOutcomeRecord[] = revertRead.state === 'read' ? revertRead.records : [];
    evidence = outcomeObservationEvidence(observed, records, fleetState);
  } catch {
    return cells;
  }

  for (const [itemId, itemTasks] of byItem) {
    const kind = kindOf(byId.get(itemId)!.area);
    // The newest task with resolved carrier evidence is this item's
    // verdict; in-flight retries shadow nothing.
    let best: { at: number; reverted: boolean } | null = null;
    for (const task of itemTasks) {
      const carrier = task.supersededBy ?? null;
      const prNumber = carrier?.number ?? task.pr?.number;
      if (typeof task.repo !== 'string' || typeof prNumber !== 'number') continue;
      const ev = evidence.get(prKey(task.repo, prNumber));
      if (!ev || (ev.mergeSha === null && ev.revertSha === null && ev.relandSha === null)) continue;
      const at = Date.parse(task.createdAt ?? '');
      if (best !== null && !(at > best.at)) continue;
      best = { at, reverted: ev.revertSha !== null };
    }
    if (best === null) continue;
    const cell = cells.get(kind) ?? { held: 0, reverted: 0 };
    if (best.reverted) cell.reverted += 1;
    else cell.held += 1;
    cells.set(kind, cell);
  }
  return cells;
}
