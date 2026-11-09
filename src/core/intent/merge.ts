import { linkMergedPull, type MergedPullNote } from './evidence.js';
import { IntentError, validRepo, type IntentLedger } from './schema.js';
import { readLedger, writeLedger } from './store.js';

/** Apply caller-supplied merge evidence in memory and count distinct directives. */
export function linkMergedPulls(ledger: IntentLedger, pulls: MergedPullNote[], at: string): { updated: number } {
  const seen = new Set<string>();
  for (const pull of pulls) {
    if (!validRepo(pull.repo)) continue;
    for (const item of linkMergedPull(ledger, pull, at)) seen.add(item.id);
  }
  return { updated: seen.size };
}

/** Persist one batch of supplied evidence; this does not verify GitHub state. */
export async function noteMergedPulls(pulls: MergedPullNote[], opts: { root?: string; now?: string } = {}): Promise<{ updated: number }> {
  const ledger = await readLedger(opts.root);
  if (ledger.items.length === 0) return { updated: 0 };
  const at = opts.now ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(at))) throw new IntentError('Time must be an ISO timestamp.');
  const result = linkMergedPulls(ledger, pulls, at);
  if (result.updated > 0) await writeLedger(ledger, opts.root);
  return result;
}
