/**
 * Persistent release evidence for intent directives, recovered from PR #4235's
 * noteShippedRelease against the current store and pure matcher. It records
 * caller-supplied release evidence only; it never proves publication or
 * verification.
 */
import { markShipped, type EvidenceStatus, type ShippedReleaseNote } from './evidence.js';
import { readLedger, writeLedger } from './store.js';

export interface NoteShippedReleaseOptions {
  /** Runs directory override, as accepted by the intent store. */
  root?: string;
  /** Evidence timestamp; wins over `release.at`, which wins over the current time. */
  now?: string;
}

export interface NoteShippedReleaseResult {
  updated: number;
  matches: { id: string; status: EvidenceStatus }[];
}

/** Read the ledger, record the release on matching directives, and write only when something matched. */
export async function noteShippedRelease(release: ShippedReleaseNote, opts: NoteShippedReleaseOptions = {}): Promise<NoteShippedReleaseResult> {
  const ledger = await readLedger(opts.root);
  if (ledger.items.length === 0) return { updated: 0, matches: [] };
  const matched = markShipped(ledger, release, opts.now ?? release.at ?? new Date().toISOString());
  if (matched.length > 0) await writeLedger(ledger, opts.root);
  return { updated: matched.length, matches: matched.map(({ id, status }) => ({ id, status })) };
}
