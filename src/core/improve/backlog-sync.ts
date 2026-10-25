/**
 * Bridge from the cloud self-improvement backlog to the outcome ledger. A
 * cloud task whose backlog item declares a metric and that has opened a PR
 * becomes a registered proposal: kind = the item's area, source = the
 * deterministic backlog (the item was chosen by priority and file order, not
 * by a model). Idempotent: a task already registered is skipped.
 */
import { createHash } from 'node:crypto';
import type { CloudBacklogItem, CloudTaskV1 } from '../cloud/types.js';
import { kindOf, type LedgerEvent, type LedgerRecord } from './outcomes.js';

export const BACKLOG_SOURCE_RULE = 'cloud-backlog';
export const backlogProposalId = (taskId: string) => createHash('sha256').update(`cloud-task:${taskId}`).digest('hex').slice(0, 10);

export function backlogRegistrations(
  tasks: readonly Pick<CloudTaskV1, 'id' | 'repo' | 'title' | 'pr' | 'backlogItemId'>[],
  items: readonly CloudBacklogItem[],
  records: readonly LedgerRecord[],
): LedgerEvent[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const registered = new Set(records.filter((r) => r.type === 'registered').map((r) => r.proposalId));
  const out: LedgerEvent[] = [];
  for (const task of tasks) {
    const item = task.backlogItemId ? byId.get(task.backlogItemId) : undefined;
    if (!item?.metric || !task.pr || task.pr.state === 'closed') continue;
    const proposalId = backlogProposalId(task.id);
    if (registered.has(proposalId)) continue;
    registered.add(proposalId);
    out.push(
      { type: 'registered', proposalId, title: item.title.slice(0, 200), proposalKind: kindOf(item.area),
        source: { kind: 'deterministic', rule: BACKLOG_SOURCE_RULE }, metric: item.metric, predictedDelta: null },
      { type: 'pr', proposalId, repository: task.repo, number: task.pr.number },
    );
  }
  return out;
}
