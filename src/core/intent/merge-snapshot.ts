import { linkMergedPull, type MergedPullNote } from './evidence.js';
import { validRepo } from './schema.js';
import { readLedger, writeLedger } from './store.js';

/** Persist new merge observations without rewriting an unchanged private ledger. */
export async function noteMergeSnapshot(pulls: MergedPullNote[], root: string, at: string): Promise<void> {
  const ledger = await readLedger(root);
  let changed = false;
  for (const pull of pulls) {
    if (!validRepo(pull.repo) || !Number.isSafeInteger(pull.number) || pull.number < 1) continue;
    const ref = `${pull.repo}#${pull.number}`.toLowerCase();
    // Evidence is the durable receipt even when the bounded PR list is full.
    const items = ledger.items.filter(item => !item.evidence.some(row => row.kind === 'pr' && row.ref.toLowerCase() === ref));
    const statuses = new Map(items.map(item => [item, item.status]));
    const matched = linkMergedPull({ items }, pull, at);
    for (const item of matched) {
      const previous = statuses.get(item)!;
      if (previous !== 'queued' && previous !== 'in-progress') item.status = previous;
    }
    if (matched.length) changed = true;
  }
  if (changed) await writeLedger(ledger, root);
}
