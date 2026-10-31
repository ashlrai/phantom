/**
 * Custody capture for one daemon dispatch (design-custody-fleet.md 3.2, step 2).
 *
 * The daemon runs each work item inside `runWithCustodyCapture`. Every engine
 * spawn in that async scope reports its custody decision here (in addition to
 * the per-spawn `onCustody` callback), so the dispatch can carry the result
 * into its receipt (`secrets.wrap`) without threading a callback through every
 * layer between the daemon and `spawnEngine`.
 *
 * The scope also carries the hold rule: when the work item declares it needs
 * project secrets, a spawn that would run unwrapped is refused before it starts.
 * Value-free: only the custody record (wrapped flag, fixed reason code, engine
 * basename, preflight exit) is kept, in memory, for the life of the dispatch.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { PhantomCustodyRecord, UnwrappedReason } from './phantom-custody.js';

/** Work item tag that declares the task needs project secrets. */
export const NEEDS_SECRETS_TAG = 'needs-secrets';
const MAX_RECORDS = 64;

export interface CustodyCapture {
  readonly requireWrap: boolean;
  readonly records: PhantomCustodyRecord[];
}

const store = new AsyncLocalStorage<CustodyCapture>();

/** Run `fn` with a fresh capture scope. Returns the result and the capture. */
export async function runWithCustodyCapture<T>(
  opts: { requireWrap: boolean },
  fn: (capture: CustodyCapture) => Promise<T>,
): Promise<T> {
  const capture: CustodyCapture = { requireWrap: opts.requireWrap === true, records: [] };
  return store.run(capture, () => fn(capture));
}

/**
 * Record one spawn's decision in the active scope, if any. Never throws.
 * Records stay bounded at MAX_RECORDS, but the first unwrapped decision is
 * always kept: once full, it replaces the last slot if no unwrapped record is
 * held yet, so a late unwrapped spawn can never yield a "wrapped" receipt.
 */
export function noteSpawnCustody(record: PhantomCustodyRecord): void {
  const c = store.getStore();
  if (!c) return;
  if (c.records.length < MAX_RECORDS) c.records.push(record);
  else if (!record.wrapped && c.records.every((r) => r.wrapped)) c.records[MAX_RECORDS - 1] = record;
}

/** True when the active scope declares secrets are required (hold unwrapped spawns). */
export function custodyRequiresWrap(): boolean {
  return store.getStore()?.requireWrap === true;
}

/** Pure. A work item declares it needs secrets via the `needs-secrets` tag. */
export function itemNeedsSecrets(item: { tags?: readonly string[] | null }): boolean {
  return Array.isArray(item.tags) && item.tags.includes(NEEDS_SECRETS_TAG);
}

/**
 * Pure. Receipt `secrets.wrap` for a dispatch: null when no engine spawned;
 * unwrapped with the first unwrapped spawn's reason when any spawn ran
 * unwrapped (one unwrapped spawn means the run was not fully under custody);
 * otherwise wrapped.
 */
export function receiptWrapFromCustody(
  records: readonly PhantomCustodyRecord[],
): { wrapped: boolean; reason: UnwrappedReason | null } | null {
  if (records.length === 0) return null;
  const firstUnwrapped = records.find((r) => !r.wrapped);
  if (firstUnwrapped && !firstUnwrapped.wrapped) return { wrapped: false, reason: firstUnwrapped.reason };
  return { wrapped: true, reason: null };
}
