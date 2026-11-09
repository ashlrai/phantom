import { lstat } from 'node:fs/promises';
import { INTENT_LEDGER_SCHEMA, IntentError, emptyLedger, type IntentItem, type IntentLedger, type IntentStatus } from './schema.js';
import { intentLedgerPath, readLedger } from './store.js';

export interface IntentSummary {
  schema: typeof INTENT_LEDGER_SCHEMA;
  present: boolean;
  sourceQuality: 'readable' | 'missing' | 'unavailable';
  countQuality: 'observed' | 'unknown';
  items: number;
  tracked: number;
  merged: number;
  shipped: number;
  verified: number;
  stale: number;
  partial: number;
  staleItems: Array<{ id: string; title: string; status: IntentStatus }>;
}

const DONE = new Set<IntentStatus>(['shipped', 'verified', 'superseded', 'closed']);

export function isStale(item: IntentItem, nowMs: number): boolean {
  if (DONE.has(item.status)) return false;
  const touched = Date.parse(item.lastTouchedAt);
  if (!Number.isFinite(touched)) return true;
  return nowMs - touched > item.staleAfterMs;
}

export function summarize(ledger: IntentLedger, nowMs: number, present = true): IntentSummary {
  if (!Number.isFinite(nowMs)) throw new IntentError('Time must be valid.');
  const staleItems = ledger.items.filter((item) => isStale(item, nowMs)).map((item) => ({
    id: item.id, title: item.title, status: item.status,
  }));
  return {
    schema: INTENT_LEDGER_SCHEMA, present, sourceQuality: present ? 'readable' : 'missing',
    countQuality: 'observed', items: ledger.items.length,
    tracked: ledger.items.filter((item) => item.rq.length > 0).length,
    merged: ledger.items.filter((item) => item.status === 'merged').length,
    shipped: ledger.items.filter((item) => item.status === 'shipped').length,
    verified: ledger.items.filter((item) => item.status === 'verified').length,
    stale: staleItems.length,
    partial: ledger.items.filter((item) => item.partial).length,
    staleItems,
  };
}

export async function intentSummary(opts: { root?: string; nowMs?: number } = {}): Promise<IntentSummary> {
  const nowMs = opts.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs)) throw new IntentError('Time must be valid.');
  try {
    await lstat(intentLedgerPath(opts.root));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return summarize(emptyLedger(), nowMs, false);
    return { ...summarize(emptyLedger(), nowMs, false), sourceQuality: 'unavailable', countQuality: 'unknown' };
  }
  try {
    const ledger = await readLedger(opts.root);
    // readLedger treats a disappearing file as empty; do not report that as observed.
    await lstat(intentLedgerPath(opts.root));
    return summarize(ledger, nowMs);
  } catch {
    return { ...summarize(emptyLedger(), nowMs, false), sourceQuality: 'unavailable', countQuality: 'unknown' };
  }
}
