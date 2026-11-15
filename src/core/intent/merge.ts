/** Persist caller-supplied merge tracking evidence; this does not establish merge truth. */
import { linkMergedPull, type MergedPullNote } from './evidence.js';
import { IntentError, validRepo } from './schema.js';
import { readLedger, writeLedger } from './store.js';

export async function noteMergedPulls(
  pulls: MergedPullNote[], opts: { root?: string; now?: string } = {},
): Promise<{ updated: number }> {
  const ledger = await readLedger(opts.root);
  if (ledger.items.length === 0) return { updated: 0 };
  const at = opts.now ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(at))) throw new IntentError('Time must be an ISO timestamp.');
  const seen = new Set<string>();
  for (const pull of pulls) {
    if (!validRepo(pull.repo)) continue;
    for (const item of linkMergedPull(ledger, pull, at)) seen.add(item.id);
  }
  if (seen.size > 0) await writeLedger(ledger, opts.root);
  return { updated: seen.size };
}
