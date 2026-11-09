import { lstat } from 'node:fs/promises';
import { IntentError, type IntentItem, type IntentStatus } from './schema.js';
import { intentLedgerPath, readLedger } from './store.js';
import { summarize, type IntentSummary } from './summary.js';

/** Return filtered records in ledger order and a summary of the entire ledger. */
export async function listIntents(opts: { root?: string; status?: IntentStatus; nowMs?: number } = {}): Promise<{ items: IntentItem[]; summary: IntentSummary }> {
  let present = true;
  try {
    await lstat(intentLedgerPath(opts.root));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new IntentError('Intent ledger could not be read.');
    present = false;
  }
  const ledger = await readLedger(opts.root);
  try {
    await lstat(intentLedgerPath(opts.root));
    if (!present) throw new IntentError('Intent ledger changed during read.');
  } catch (error) {
    if (present || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new IntentError('Intent ledger could not be read.');
    }
  }
  return {
    items: opts.status ? ledger.items.filter(item => item.status === opts.status) : ledger.items,
    summary: summarize(ledger, opts.nowMs ?? Date.now(), present),
  };
}

export async function getIntent(id: string, root?: string): Promise<IntentItem | null> {
  const ledger = await readLedger(root);
  return ledger.items.find(item => item.id === id) ?? null;
}
