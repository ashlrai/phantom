/**
 * Retry selector over a previous release-advance-batch report
 * (RQ-PHX-RELEASEBATCHRETRY05SRW2). A release operator feeds one bounded
 * JSON document — a batch report or one previous retry report — and
 * only its unsuccessful entries ({busy,blocked,refused,unavailable}) are
 * handed, in original order, to a fresh bounded batch. Successful entries
 * ({planned,submitted,no-op,already-submitted}) are kept out of the retry.
 *
 * The supplied report is selection input, never proof of current
 * eligibility: every retried identity goes through
 * advanceReleaseCandidateOnce again with fresh evidence, so an old blocked
 * entry can now submit, and a candidate already dispatched elsewhere is
 * still deduped by the existing per-repo/tag receipt. This module stores no
 * receipts of its own; the once layer owns all coordination.
 *
 * Validation happens in full before any candidate runs: the document must
 * be a version-1 batch report whose top-level tallies and completed list
 * agree with its entries, every entry must carry the once-report shape with
 * a known outcome — an unknown outcome is rejected, never assumed retryable
 * — and every repo/tag identity must be valid and distinct (the same
 * validator the batch input uses). `--apply` on the report itself is data
 * about the old run, never inherited: only this invocation's own flag
 * dispatches. `submitted` still means gh accepted a workflow_dispatch —
 * never that a release was published, installed or notified.
 */
import {
  MAX_BATCH_CANDIDATES,
  parseReleaseAdvanceBatchInput,
  runReleaseAdvanceBatch,
  type ReleaseAdvanceBatchOptions,
  type ReleaseAdvanceBatchReport,
} from './release-advance-batch.js';
import type { ReleaseAdvanceOnceOutcome } from './release-advance-once.js';

export const MAX_RETRY_INPUT_BYTES = 1024 * 1024;

/** Outcome set the once layer can emit; anything else is a corrupt report. */
const KNOWN_OUTCOMES: ReadonlySet<string> = new Set<ReleaseAdvanceOnceOutcome>([
  'planned', 'submitted', 'no-op', 'already-submitted', 'blocked', 'unavailable', 'refused', 'busy',
]);
/** Same success partition as runReleaseAdvanceBatch: everything else retries. */
const SUCCESSFUL: ReadonlySet<string> = new Set<ReleaseAdvanceOnceOutcome>([
  'planned', 'submitted', 'no-op', 'already-submitted',
]);
const LOCKS: ReadonlySet<string> = new Set(['not-taken', 'acquired', 'busy', 'unsafe']);
const RECEIPT_STATES: ReadonlySet<string> = new Set([
  'none', 'matched', 'stale-candidate', 'terminal-failed', 'recorded', 'record-failed', 'unreadable',
]);

const REPORT_KEYS = ['version', 'apply', 'total', 'succeeded', 'unsuccessful', 'counts', 'completed', 'remaining', 'entries'];
const RETRY_KEYS = ['version', 'apply', 'input', 'retried', 'skipped', 'batch'];
const ENTRY_KEYS = ['version', 'repo', 'tag', 'apply', 'outcome', 'reason', 'lock', 'receipt', 'advance'];

export interface ReleaseRetryBatchEntry {
  repo: string;
  tag: string;
  previousOutcome: ReleaseAdvanceOnceOutcome;
}

export interface ReleaseRetryBatchSelection {
  /** Entries read from the supplied report. */
  input: number;
  /** Unsuccessful entries, in supplied order — the fresh batch's input. */
  retried: ReleaseRetryBatchEntry[];
  /** Successful entries kept out of the retry, in supplied order. */
  skipped: ReleaseRetryBatchEntry[];
}

export interface ReleaseRetryBatchReport extends ReleaseRetryBatchSelection {
  version: 1;
  apply: boolean;
  /** Fresh evidence for the retried identities; null when nothing needed a retry. */
  batch: ReleaseAdvanceBatchReport | null;
}

export type ReleaseRetryBatchParse =
  | { ok: true; selection: ReleaseRetryBatchSelection }
  | { ok: false; reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const keysExactly = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

const safeInt = (value: unknown, min: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= min;

/** Shallow once-report check; only outcome and identity feed the selection. */
function validEntry(value: unknown): value is Record<string, unknown> & {
  repo: string; tag: string; apply: boolean; outcome: ReleaseAdvanceOnceOutcome;
} {
  if (!isRecord(value) || !keysExactly(value, ENTRY_KEYS)) return false;
  if (value.version !== 1 || typeof value.repo !== 'string' || typeof value.tag !== 'string'
    || typeof value.apply !== 'boolean' || typeof value.reason !== 'string'
    || typeof value.outcome !== 'string' || !KNOWN_OUTCOMES.has(value.outcome)
    || typeof value.lock !== 'string' || !LOCKS.has(value.lock)) return false;
  const receipt = value.receipt;
  if (!isRecord(receipt) || !keysExactly(receipt, ['state', 'record'])
    || typeof receipt.state !== 'string' || !RECEIPT_STATES.has(receipt.state)
    || !(receipt.record === null || isRecord(receipt.record))) return false;
  return value.advance === null || isRecord(value.advance);
}

/**
 * Parse and cross-check a supplied batch report before anything runs.
 * Rejects malformed JSON, unknown or missing fields at any level, an
 * unsupported version, tallies that disagree with the entries, unknown
 * outcomes, invalid or duplicate identities and out-of-range totals. Repo
 * and tag text is validated by the same parser that guards the batch input,
 * so a retry can never nominate a candidate the batch itself would refuse.
 */
export function parseReleaseRetryBatchInput(text: string): ReleaseRetryBatchParse {
  if (Buffer.byteLength(text, 'utf8') > MAX_RETRY_INPUT_BYTES) return { ok: false, reason: 'input_too_large' };
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return { ok: false, reason: 'not_json' }; }
  if (!isRecord(doc)) return { ok: false, reason: 'not_object' };
  return Object.hasOwn(doc, 'batch') ? parseRetryReport(doc) : parseBatchReport(doc);
}

/** Deliberately non-recursive: a retry wrapper may contain only a batch. */
function parseRetryReport(doc: Record<string, unknown>): ReleaseRetryBatchParse {
  const invalid = (): ReleaseRetryBatchParse => ({ ok: false, reason: 'retry_wrapper_invalid' });
  if (!keysExactly(doc, RETRY_KEYS)) return { ok: false, reason: 'unknown_or_missing_fields' };
  if (doc.version !== 1) return { ok: false, reason: 'unsupported_version' };
  const { apply, input, retried, skipped, batch } = doc;
  if (typeof apply !== 'boolean' || !safeInt(input, 0) || input > MAX_BATCH_CANDIDATES
    || !Array.isArray(retried) || !Array.isArray(skipped)
    || retried.length + skipped.length !== input) return invalid();
  const partitions: ReleaseRetryBatchEntry[][] = [[], []];
  for (const [index, values] of [retried, skipped].entries()) {
    for (const value of values) {
      if (!isRecord(value) || !keysExactly(value, ['repo', 'tag', 'previousOutcome'])
        || typeof value.repo !== 'string' || typeof value.tag !== 'string'
        || typeof value.previousOutcome !== 'string' || !KNOWN_OUTCOMES.has(value.previousOutcome)
        || SUCCESSFUL.has(value.previousOutcome) !== (index === 1)) return invalid();
      partitions[index]!.push({ repo: value.repo, tag: value.tag,
        previousOutcome: value.previousOutcome as ReleaseAdvanceOnceOutcome });
    }
  }
  const selection = { input, retried: partitions[0]!, skipped: partitions[1]! };
  // Validate the entire old partition, including skipped identities and overlap.
  if (input > 0 && !parseReleaseAdvanceBatchInput(JSON.stringify({ version: 1,
    candidates: [...selection.retried, ...selection.skipped].map(({ repo, tag }) => ({ repo, tag })),
  })).ok) return invalid();
  if (batch === null) {
    return retried.length === 0 ? { ok: true, selection } : invalid();
  }
  if (!isRecord(batch) || batch.apply !== apply || batch.total !== retried.length) return invalid();
  const parsed = parseBatchReport(batch);
  if (!parsed.ok) return parsed;
  const entries = batch.entries as { repo: string; tag: string; outcome: string }[];
  const counts = batch.counts as Record<string, number>;
  if ((batch.remaining as unknown[]).length !== 0
    || entries.some((entry, i) => entry.repo !== selection.retried[i]?.repo || entry.tag !== selection.retried[i]?.tag)
    || Object.entries(counts).some(([outcome, n]) => entries.filter(entry => entry.outcome === outcome).length !== n)) {
    return invalid();
  }
  // Only the latest batch selects the next attempt; old skips never re-enter.
  return parsed;
}

function parseBatchReport(doc: Record<string, unknown>): ReleaseRetryBatchParse {
  if (!keysExactly(doc, REPORT_KEYS)) return { ok: false, reason: 'unknown_or_missing_fields' };
  if (doc.version !== 1) return { ok: false, reason: 'unsupported_version' };
  const { apply, total, succeeded, unsuccessful, counts, completed, remaining, entries } = doc;
  if (typeof apply !== 'boolean' || !Array.isArray(entries)) return { ok: false, reason: 'field_invalid' };
  if (!safeInt(total, 1) || total > MAX_BATCH_CANDIDATES || total !== entries.length) {
    return { ok: false, reason: 'entry_count' };
  }
  if (!safeInt(succeeded, 0) || !safeInt(unsuccessful, 0) || succeeded + unsuccessful !== total) {
    return { ok: false, reason: 'tally_mismatch' };
  }
  if (!isRecord(counts) || !Array.isArray(completed) || completed.length !== total
    || !Array.isArray(remaining)) {
    return { ok: false, reason: 'field_invalid' };
  }
  let counted = 0;
  for (const [outcome, n] of Object.entries(counts)) {
    if (!KNOWN_OUTCOMES.has(outcome) || !safeInt(n, 1)) return { ok: false, reason: 'counts_invalid' };
    counted += n;
  }
  if (counted !== total) return { ok: false, reason: 'tally_mismatch' };
  const retried: ReleaseRetryBatchEntry[] = [];
  const skipped: ReleaseRetryBatchEntry[] = [];
  const candidates: { repo: string; tag: string }[] = [];
  let succeededSeen = 0;
  for (const [index, value] of entries.entries()) {
    if (!validEntry(value)) return { ok: false, reason: 'entry_invalid' };
    if (value.apply !== apply) return { ok: false, reason: 'entry_invalid' };
    if (completed[index] !== `${value.repo}@${value.tag}`) return { ok: false, reason: 'completed_mismatch' };
    const entry = { repo: value.repo, tag: value.tag, previousOutcome: value.outcome };
    (SUCCESSFUL.has(value.outcome) ? skipped : retried).push(entry);
    if (SUCCESSFUL.has(value.outcome)) succeededSeen += 1;
    candidates.push({ repo: value.repo, tag: value.tag });
  }
  if (succeededSeen !== succeeded) return { ok: false, reason: 'tally_mismatch' };
  if (!remaining.every(item => typeof item === 'string')) return { ok: false, reason: 'field_invalid' };
  const identities = parseReleaseAdvanceBatchInput(JSON.stringify({ version: 1, candidates }));
  if (!identities.ok) {
    return { ok: false, reason: identities.reason === 'duplicate_candidate' ? 'duplicate_entry' : 'entry_identity_invalid' };
  }
  return { ok: true, selection: { input: total, retried, skipped } };
}

/**
 * Run the retried identities through the existing serialized batch with
 * fresh evidence, in supplied order. An empty selection returns an explicit
 * no-work report and the batch is never invoked — `runReleaseAdvanceBatch`
 * requires at least one candidate. The candidate bound is re-checked here
 * so a caller that skipped the parser can never queue an unbounded list.
 */
export async function runReleaseRetryBatch(
  selection: ReleaseRetryBatchSelection,
  opts: ReleaseAdvanceBatchOptions = {},
): Promise<ReleaseRetryBatchReport> {
  const apply = opts.apply === true;
  if (selection.retried.length === 0) return { version: 1, apply, ...selection, batch: null };
  if (selection.retried.length > MAX_BATCH_CANDIDATES) throw new RangeError('invalid retry list');
  const batch = await runReleaseAdvanceBatch(
    selection.retried.map(({ repo, tag }) => ({ repo, tag })), opts,
  );
  return { version: 1, apply, ...selection, batch };
}
