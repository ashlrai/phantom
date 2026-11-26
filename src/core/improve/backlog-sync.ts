/**
 * Bridge from the cloud self-improvement backlog to the outcome ledger. A
 * cloud task whose backlog item declares a metric and that has opened a PR
 * becomes a registered proposal: kind = the item's area, source = the
 * deterministic backlog (the item was chosen by priority and file order, not
 * by a model). Idempotent: a task already registered is skipped.
 *
 * The `pr` event names the PR that can still carry the work to a merge. When
 * cloud intake has superseded the task's cloud PR (`supersededBy`), that is
 * the fleet App PR — the cloud PR is already closed by design, so its own
 * 'closed' state must not read as a dead proposal, and the fleet PR's number
 * is what `phm improve measure`, the revert journal and post-merge
 * observation all need to follow.
 *
 * `syncCloudBacklogOutcomes` runs the same registration `phm improve
 * sync-backlog` does, as a total function the cloud scheduler can call on its
 * hourly tick: without it the ledger only learns about backlog PRs when an
 * operator remembers the manual verb, and `areaLeverage` ranking in
 * cloud/backlog.ts starves for evidence. The scheduler calls it before each
 * launch pick so the freshest merges reorder the next item.
 */
import { createHash } from 'node:crypto';
import { readCloudBacklog } from '../cloud/backlog.js';
import { listCloudTasks } from '../cloud/store.js';
import type { CloudBacklogItem, CloudTaskV1 } from '../cloud/types.js';
import { appendLedger, kindOf, readLedger, type LedgerEvent, type LedgerRead, type LedgerRecord } from './outcomes.js';

export const BACKLOG_SOURCE_RULE = 'cloud-backlog';
export const backlogProposalId = (taskId: string) => createHash('sha256').update(`cloud-task:${taskId}`).digest('hex').slice(0, 10);

export function backlogRegistrations(
  tasks: readonly (Pick<CloudTaskV1, 'id' | 'repo' | 'title' | 'pr' | 'backlogItemId'> &
    Partial<Pick<CloudTaskV1, 'state' | 'supersededBy'>>)[],
  items: readonly CloudBacklogItem[],
  records: readonly LedgerRecord[],
): LedgerEvent[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const registered = new Set(records.filter((r) => r.type === 'registered').map((r) => r.proposalId));
  const out: LedgerEvent[] = [];
  for (const task of tasks) {
    const item = task.backlogItemId ? byId.get(task.backlogItemId) : undefined;
    if (!item?.metric) continue;
    // The PR that can still carry the work to a merge: once cloud intake
    // supersedes the cloud PR, the fleet App PR is the carrier and the cloud
    // PR's own 'closed' state is expected, not dead. task.state is the
    // tracker's verdict on that carrier — only an open or merged fleet PR
    // still owes this proposal its outcome.
    const carrier = task.supersededBy ?? null;
    let prNumber: number;
    if (carrier) {
      if (task.state !== 'pr-open' && task.state !== 'merged') continue;
      prNumber = carrier.number;
    } else {
      if (!task.pr || task.pr.state === 'closed') continue;
      prNumber = task.pr.number;
    }
    const proposalId = backlogProposalId(task.id);
    if (registered.has(proposalId)) continue;
    registered.add(proposalId);
    out.push(
      { type: 'registered', proposalId, title: item.title.slice(0, 200), proposalKind: kindOf(item.area),
        source: { kind: 'deterministic', rule: BACKLOG_SOURCE_RULE }, metric: item.metric, predictedDelta: null },
      { type: 'pr', proposalId, repository: task.repo, number: prNumber },
    );
  }
  return out;
}

export interface BacklogOutcomeSyncDeps {
  /** Cloud task store read; defaults to every stored task. */
  tasks?: () => readonly CloudTaskV1[];
  /** Backlog view the tasks are matched against; defaults to readCloudBacklog. */
  items?: (tasks: readonly CloudTaskV1[]) => readonly CloudBacklogItem[];
  /** Outcome ledger read; defaults to readLedger. */
  ledger?: () => LedgerRead;
  /** Ledger append; defaults to appendLedger. */
  append?: (event: LedgerEvent) => unknown;
  now?: () => Date;
}

export interface BacklogOutcomeSync {
  /** False when the ledger could not be read intact; nothing was written. */
  intact: boolean;
  /** Digest-chain break reasons when intact is false. */
  reasons: string[];
  /** 'registered' events appended by this call (each pairs with one 'pr'). */
  registered: number;
  /** Total ledger events appended before any failure stopped the pass. */
  appended: number;
  /** Set when the pass stopped before finishing; absent on a complete run. */
  reason?: 'source-unavailable' | 'append-failed';
}

/**
 * Register every cloud task whose backlog item declares a metric and whose PR
 * is not closed (open or merged — a merge still needs its outcome measured) —
 * the same events `phm improve sync-backlog` appends, as a total function
 * safe to run on a timer. Never throws: an unreadable ledger, an unavailable
 * store or a failed append is reported in the result, and a second call
 * appends nothing (backlogRegistrations dedupes on the chain).
 */
export function syncCloudBacklogOutcomes(deps: BacklogOutcomeSyncDeps = {}): BacklogOutcomeSync {
  const out: BacklogOutcomeSync = { intact: true, reasons: [], registered: 0, appended: 0 };
  let events: LedgerEvent[];
  try {
    const read = (deps.ledger ?? readLedger)();
    if (!read.intact) return { ...out, intact: false, reasons: read.reasons };
    const tasks = (deps.tasks ?? (() => listCloudTasks(Number.MAX_SAFE_INTEGER)))();
    const items = deps.items ? deps.items(tasks) : readCloudBacklog(tasks, (deps.now ?? (() => new Date()))()).items;
    events = backlogRegistrations(tasks, items, read.records);
  } catch {
    return { ...out, reason: 'source-unavailable' };
  }
  const append = deps.append ?? ((event: LedgerEvent) => appendLedger(event));
  for (const event of events) {
    try {
      append(event);
    } catch {
      return { ...out, reason: 'append-failed' };
    }
    out.appended += 1;
    if (event.type === 'registered') out.registered += 1;
  }
  return out;
}
