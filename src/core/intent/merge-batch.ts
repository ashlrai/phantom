/**
 * Persistent batch merge evidence for intent directives, recovered from the
 * retained noteMergedPulls (PR #4235, commit 80f1d451) against the current
 * pure matcher, schema and store. Each call reads the ledger, links every
 * valid pull through linkMergedPull and writes once, so a refused batch
 * leaves the persisted bytes unchanged.
 *
 * Deliberate safety-compatible differences from the original:
 * - A pull whose matched directives all already carry its `pr` evidence row
 *   is skipped, so replaying a batch cannot duplicate PR or evidence records;
 *   on partial overlap the duplicate row is removed after linking.
 * - The ledger is written only when a pull actually changed an item.
 * - `opts.now` (or the current time) is the batch timestamp for every pull,
 *   exactly as the original `nowIso(opts.now)` behaved; a pull's own `at`
 *   is ignored inside a batch. `updated` keeps the original meaning: the
 *   number of distinct directives the batch's valid pulls match.
 */
import {
  EvidenceError, carriedKeys, findByKeys, linkMergedPull,
  type MergedPullNote,
} from './evidence.js';
import { IntentError, validRepo, type IntentItem } from './schema.js';
import { readLedger, writeLedger } from './store.js';

export interface NoteMergedPullsOptions {
  /** Runs directory override, as accepted by the intent store. */
  root?: string;
  /** Batch timestamp applied to every pull; wins over the current time. */
  now?: string;
}

export interface NoteMergedPullsResult {
  updated: number;
}

function pullRef(pull: Pick<MergedPullNote, 'repo' | 'number'>): string {
  return `${pull.repo}#${pull.number}`;
}

function hasPullEvidence(item: IntentItem, ref: string): boolean {
  return item.evidence.some((row) => row.kind === 'pr' && row.ref === ref);
}

/** Keep the first `pr` row for `ref`, drop any later duplicates. */
function dedupePullEvidence(item: IntentItem, ref: string): void {
  let kept = false;
  item.evidence = item.evidence.filter((row) => {
    if (row.kind !== 'pr' || row.ref !== ref) return true;
    if (kept) return false;
    kept = true;
    return true;
  });
}

/**
 * Record a batch of merged pulls against the persisted ledger. Pulls with an
 * invalid repo are skipped (original behavior); a pull with an invalid number
 * refuses the whole batch before anything is written. Returns the count of
 * distinct directives matched.
 */
export async function noteMergedPulls(pulls: MergedPullNote[], opts: NoteMergedPullsOptions = {}): Promise<NoteMergedPullsResult> {
  const ledger = await readLedger(opts.root);
  if (ledger.items.length === 0) return { updated: 0 };
  if (!Array.isArray(pulls)) throw new IntentError('Merged pulls must be an array.');
  const at = opts.now ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(at))) throw new IntentError('Time must be an ISO timestamp.');
  const known = [...new Set(ledger.items.flatMap((item) => item.rq))];
  const seen = new Set<string>();
  let dirty = false;
  for (const pull of pulls) {
    if (!pull || typeof pull.repo !== 'string' || !validRepo(pull.repo)) continue;
    if (!Number.isSafeInteger(pull.number) || pull.number < 1) {
      throw new EvidenceError('A merged pull needs owner/name and a pull number.');
    }
    const keys = [...new Set([
      ...carriedKeys(pull.title, known),
      ...carriedKeys(pull.branch ?? '', known),
    ])];
    const matched = findByKeys(ledger, keys);
    for (const item of matched) seen.add(item.id);
    const ref = pullRef(pull);
    const recorded = new Set(matched.filter((item) => hasPullEvidence(item, ref)).map((item) => item.id));
    if (recorded.size === matched.length) continue;
    linkMergedPull(ledger, pull, at);
    for (const item of matched) if (recorded.has(item.id)) dedupePullEvidence(item, ref);
    dirty = true;
  }
  if (dirty) await writeLedger(ledger, opts.root);
  return { updated: seen.size };
}
