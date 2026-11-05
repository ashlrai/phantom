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
import type { CiReceiptAwaitBatchReport, CiReceiptAwaitBatchTarget } from './ci-receipt-await-batch.js';
import { awaitCiReceiptBatch } from './ci-receipt-await-batch.js';
import { parseCiResumePrior } from './ci-resume-inputs.js';

export const CI_RECEIPT_RETRY_MAX_INPUT_BYTES = 64 * 1024;
export const CI_RECEIPT_RETRY_MAX_RETRIES = 16;

const REVISION = /^\d{1,6}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;

/** The exact schema the previous await batch produced. */
export interface CiReceiptRetryBatchInput {
  version: 1;
  total: number;
  bound: number;
  failed: number;
  notStarted: number;
  timedOut: boolean;
  aborted: boolean;
  entries: Array<Record<string, unknown>>;
  /** Optional ISO-8601 emitted when the previous await ran. */
  emittedAt?: string;
  /** Optional user-provided note carried verbatim. */
  note?: string;
}

export type CiReceiptRetryParse =
  | { ok: true; targets: CiReceiptAwaitBatchTarget[] }
  | { ok: false; reason: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

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
  entries: unknown[],
): { ok: true; targets: CiReceiptAwaitBatchTarget[] }
  | { ok: false; reason: string } {
  const results: CiReceiptAwaitBatchTarget[] = [];
  for (const raw of entries) {
    if (!isRecord(raw)) return { ok: false, reason: 'target_invalid' };
    const rev = String(raw.retryRevision ?? '');
    if (!REVISION.test(rev) && rev !== '') return { ok: false, reason: 'target_invalid' };
    const outcome = String(raw.outcome ?? '');
    if (outcome !== 'failed' && outcome !== 'not-started') continue; // already bound — skip
    const fields: CiReceiptAwaitBatchTarget = {
      repo: String(raw.repo ?? ''),
      run: Number(raw.run),
      attempt: Number(raw.attempt),
      artifactName: String(raw.artifactName ?? ''),
    };
    if (typeof fields.repo !== 'string' || fields.repo.length < 2 || fields.repo.length > 100
      || typeof fields.run !== 'number' || !Number.isSafeInteger(fields.run) || fields.run < 1
      || typeof fields.attempt !== 'number' || !Number.isSafeInteger(fields.attempt) || fields.attempt < 1
      || typeof fields.artifactName !== 'string' || fields.artifactName.length < 1
      || fields.artifactName.startsWith('-')) {
      return { ok: false, reason: 'target_invalid' };
    }
    results.push(fields);
  }
  // Deduplicate by exact identity.
  const seen = new Set<string>();
  const unique: CiReceiptAwaitBatchTarget[] = [];
  for (const t of results) {
    const key = `${t.repo.toLowerCase()}\0${t.run}\0${t.attempt}\0${t.artifactName}`;
    if (!seen.has(key)) { seen.add(key); unique.push(t); }
  }
  if (unique.length > CI_RECEIPT_RETRY_MAX_RETRIES) {
    return { ok: false, reason: 'retry_target_count' };
  }
  return { ok: true, targets: unique };
}

/**
 * Parse a previous batch report, extract failed and not-started targets
 * (preserving original-order semantics), deduplicate by identity.
 */
export function parseCiReceiptRetryBatchInput(text: string): CiReceiptRetryParse {
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return { ok: false, reason: 'not_json' }; }
  if (!isRecord(doc)) return { ok: false, reason: 'not_object' };
  const keys = Object.keys(doc);
  // Allow version + total + bound + failed + notStarted + timedOut +
  // aborted + entries (+ optional emittedAt/note).
  if (keys.length < 8 || !keys.includes('version') || !keys.includes('entries')
    || !keys.includes('total') || !keys.includes('bound') || !keys.includes('failed')
    || !keys.includes('notStarted') || !keys.includes('timedOut') || !keys.includes('aborted')) {
    return { ok: false, reason: 'unknown_or_missing_fields' };
  }
  const extraKeys = keys.filter(k => !keys.includes(k) === false
    && !['version', 'total', 'bound', 'failed', 'notStarted', 'timedOut', 'aborted', 'entries'].includes(k));
  // Optional fields: emittedAt (ISO-8601) and note (any string).
  for (const ek of extraKeys) {
    if (ek === 'emittedAt') {
      if (typeof (doc as Record<string, unknown>).emittedAt !== 'string' || !ISO_DATE.test((doc as Record<string, unknown>).emittedAt!)) {
        return { ok: false, reason: 'unknown_or_missing_fields' };
      }
    } else if (ek === 'note') {
      if (typeof (doc as Record<string, unknown>).note !== 'string') {
        return { ok: false, reason: 'unknown_or_missing_fields' };
      }
    } else {
      return { ok: false, reason: 'unknown_or_missing_fields' };
    }
  }
  const ver = doc.version;
  if (ver !== 1) return { ok: false, reason: 'unsupported_version' };
  const tot = doc.total;
  if (typeof tot !== 'number' || !Number.isSafeInteger(tot) || tot < 0) {
    return { ok: false, reason: 'malformed_counts' };
  }
  const bnd = doc.bound;
  const fld = doc.failed;
  const nst = doc.notStarted;
  if (typeof bnd !== 'number' || !Number.isSafeInteger(bnd) || typeof fld !== 'number' || !Number.isSafeInteger(fld)
    || typeof nst !== 'number' || !Number.isSafeInteger(nst)
    || bnd + fld + nst !== tot) {
    return { ok: false, reason: 'malformed_counts' };
  }
  if (!Array.isArray(doc.entries)) return { ok: false, reason: 'entries_missing' };
  return extractTargets(doc.entries);
}

export interface CiReceiptRetryBatchOptions {
  timeoutMs: number;
  pollMs?: number;
  signal?: AbortSignal;
}
export interface CiReceiptRetryBatchDeps {
  /** Test seam: defaults to awaitCiReceiptBatch. */
  retry?: typeof awaitCiReceiptBatch;
  /** Monotonic milliseconds. */
  now?: () => number;
  /** Resolves after ms or as soon as the signal aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
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
