/**
 * Retry-failed-or-not-started targets from a previous
 * `ci-receipt-await-batch` report. One bounded UTF-8 document — the
 * version-1 batch report — names every target that still needs work.
 *
 * The whole document is validated before any network touch: duplicate
 * identities, malformed fields, unknown keys, or an out-of-range retry
 * list are all rejected while nothing has touched the network.
 *
 * Failed and not-started entries (in their original order) are collected
 * and passed as a fresh target list to `awaitCiReceiptBatch` under a
 * shared per-retry deadline. Bound entries (outcome === 'bound') are
 * silently skipped — no prior is copied, no claim is retouched.
 * Entries already reached cause zero network reads.
 *
 * Output is the same batch report schema (original target list is
 * replaced by the retry batch report) so a further retry is pipeable.
 * When no unresolved targets remain, a documented empty-successful
 * report is emitted without calling the non-empty waiter.
 */
import type { CiReceiptAwaitBatchDeps, CiReceiptAwaitBatchReport, CiReceiptAwaitBatchTarget } from './ci-receipt-await-batch.js';
import {
  awaitCiReceiptBatch,
  CI_RECEIPT_AWAIT_BATCH_MAX_TARGETS,
  parseCiReceiptAwaitBatchInput,
} from './ci-receipt-await-batch.js';
import {
  CI_RECEIPT_ENTRY_KEYS,
  CI_RECEIPT_OUTCOMES,
  CI_RECEIPT_REPORT_KEYS,
  hasExactKeys,
  isNonNegativeInt,
  isPlainRecord,
} from './ci-receipt-shared.js';

export const CI_RECEIPT_RETRY_MAX_INPUT_BYTES = 64 * 1024;
const REPORT_KEY_SET = new Set<string>(CI_RECEIPT_REPORT_KEYS);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;

export type CiReceiptRetryParse =
  | { ok: true; targets: CiReceiptAwaitBatchTarget[] }
  | { ok: false; reason: string };

/** Return an empty successful report — no network work. */
function emptyReport() {
  return {
    report: { version: 1, total: 0, bound: 0, failed: 0, notStarted: 0,
      timedOut: false, aborted: false, entries: [] as CiReceiptAwaitBatchReport['entries'] },
    diagnostics: [] as string[],
  };
}

/** Extract unresolved targets from a validated previous report. */
function extractTargets(
  entries: Record<string, unknown>[],
): { ok: true; targets: CiReceiptAwaitBatchTarget[] }
  | { ok: false; reason: string } {
  const targets: CiReceiptAwaitBatchTarget[] = [];
  const all: CiReceiptAwaitBatchTarget[] = [];
  for (const raw of entries) {
    if (!hasExactKeys(raw, CI_RECEIPT_ENTRY_KEYS)
      || typeof raw.outcome !== 'string' || !CI_RECEIPT_OUTCOMES.has(raw.outcome)
      || (raw.prior !== null && !isPlainRecord(raw.prior))
      || (raw.reason !== null && typeof raw.reason !== 'string')) {
      return { ok: false, reason: 'target_invalid' };
    }
    const target = { repo: raw.repo, run: raw.run, attempt: raw.attempt, artifactName: raw.artifactName };
    all.push(target as CiReceiptAwaitBatchTarget);
    if (raw.outcome !== 'bound') targets.push(target as CiReceiptAwaitBatchTarget);
  }
  if (all.length > CI_RECEIPT_AWAIT_BATCH_MAX_TARGETS) return { ok: false, reason: 'retry_target_count' };
  if (all.length && !parseCiReceiptAwaitBatchInput(JSON.stringify({ version: 1, targets: all })).ok) {
    return { ok: false, reason: 'target_invalid' };
  }
  return { ok: true, targets };
}

/**
 * Parse a previous batch report, extract failed and not-started targets
 * (preserving original-order semantics), rejecting duplicate identities.
 */
export function parseCiReceiptRetryBatchInput(text: string): CiReceiptRetryParse {
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return { ok: false, reason: 'not_json' }; }
  if (!isPlainRecord(doc)) return { ok: false, reason: 'not_object' };
  const keys = Object.keys(doc);
  // Allow the required version-1 batch report keys plus optional emittedAt/note.
  if (!CI_RECEIPT_REPORT_KEYS.every((key) => keys.includes(key))) {
    return { ok: false, reason: 'unknown_or_missing_fields' };
  }
  for (const key of keys) {
    if (REPORT_KEY_SET.has(key)) continue;
    if (key === 'emittedAt') {
      if (typeof doc.emittedAt !== 'string' || !ISO_DATE.test(doc.emittedAt)) {
        return { ok: false, reason: 'unknown_or_missing_fields' };
      }
    } else if (key === 'note') {
      if (typeof doc.note !== 'string') {
        return { ok: false, reason: 'unknown_or_missing_fields' };
      }
    } else {
      return { ok: false, reason: 'unknown_or_missing_fields' };
    }
  }
  if (doc.version !== 1) return { ok: false, reason: 'unsupported_version' };
  if (!isNonNegativeInt(doc.total) || !isNonNegativeInt(doc.bound)
    || !isNonNegativeInt(doc.failed) || !isNonNegativeInt(doc.notStarted)
    || doc.bound + doc.failed + doc.notStarted !== doc.total) {
    return { ok: false, reason: 'malformed_counts' };
  }
  if (!Array.isArray(doc.entries)) return { ok: false, reason: 'entries_missing' };
  if (doc.entries.some((e) => !isPlainRecord(e))) return { ok: false, reason: 'target_invalid' };
  const entries = doc.entries as Record<string, unknown>[];
  if (entries.length !== doc.total || typeof doc.timedOut !== 'boolean' || typeof doc.aborted !== 'boolean'
    || entries.filter((e) => e.outcome === 'bound').length !== doc.bound
    || entries.filter((e) => e.outcome === 'failed').length !== doc.failed
    || entries.filter((e) => e.outcome === 'not-started').length !== doc.notStarted) {
    return { ok: false, reason: 'malformed_counts' };
  }
  return extractTargets(entries);
}

export interface CiReceiptRetryBatchOptions {
  timeoutMs: number;
  pollMs?: number;
  signal?: AbortSignal;
}
export interface CiReceiptRetryBatchDeps extends CiReceiptAwaitBatchDeps {
  /** Test seam: defaults to awaitCiReceiptBatch. */
  retry?: typeof awaitCiReceiptBatch;
}

/**
 * Select failed / not-started entries from a validated previous report and
 * pass them to awaitCiReceiptBatch under a fresh shared deadline. Bound
 * entries cause zero reads.
 */
export async function retryCiReceiptBatch(
  targets: readonly CiReceiptAwaitBatchTarget[],
  opts: CiReceiptRetryBatchOptions,
  deps: CiReceiptRetryBatchDeps = {},
) {
  // Empty retry list → emit an empty successful report without network work.
  if (targets.length < 1) {
    return emptyReport();
  }
  const wait = deps.retry ?? awaitCiReceiptBatch;
  return wait(targets, opts, deps);
}
