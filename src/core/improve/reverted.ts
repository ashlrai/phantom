/**
 * Which PRs were reverted after merging, from both places `phm improve observe`
 * records it: the outcome ledger (registered self-improvement PRs) and cloud
 * tasks (`outcome.revertedBy`). Keys are `prKey(repo, number)`. A ledger
 * outcome counts only while its last observation is a revert, so a re-landed
 * change is not in the set.
 */
import { listCloudTasks } from '../cloud/store.js';
import type { CloudTaskV1 } from '../cloud/types.js';
import { prKey } from './lesson-trial.js';
import { readLedger, scoreOutcomes, type LedgerRecord } from './outcomes.js';

export function revertedPrKeys(
  tasks: readonly CloudTaskV1[] = listCloudTasks(Number.MAX_SAFE_INTEGER),
  records: readonly LedgerRecord[] = readLedger().records,
): Set<string> {
  const keys = new Set<string>();
  for (const o of scoreOutcomes(records)) if (o.reverted && o.pr) keys.add(prKey(o.pr.repository, o.pr.number));
  for (const t of tasks) if (t.outcome?.revertedBy && t.pr) keys.add(prKey(t.repo, t.pr.number));
  return keys;
}
