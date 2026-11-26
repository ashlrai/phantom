/**
 * Batch-report selector for the RESUME-FROM-FAILURE and t1626u batching
 * orders (RQ-PHX-CIRECEIPTSELECT05SSL1). Pipe one bounded
 * ci-receipt-await-batch report in, name one target by all four exact
 * identity fields — repo (case-insensitive, like the evidence binder),
 * run, attempt and artifactName — and get that entry's validated
 * CiResumePrior document out, producer digests verbatim.
 *
 * The whole report is validated before any selection: version, consistent
 * counts, legal outcomes, outcome/prior consistency and no duplicate exact
 * identities. Selection is by exact identity only — never position, name
 * substring or newest. A selected prior is evidence, not a reuse decision:
 * the resume planner still decides. No network, files or CI actions.
 */
import { parseCiResumePrior, type CiResumePrior } from './ci-resume-inputs.js';
import {
  CI_RECEIPT_AWAIT_BATCH_MAX_TARGETS,
  type CiReceiptAwaitBatchEntry,
  type CiReceiptAwaitBatchOutcome,
  type CiReceiptAwaitBatchTarget,
} from './ci-receipt-await-batch.js';
import {
  CI_RECEIPT_ENTRY_KEYS,
  CI_RECEIPT_MAX_REASON,
  CI_RECEIPT_OUTCOMES,
  CI_RECEIPT_REPORT_KEYS,
  ciReceiptTargetKey,
  cleanCiReceiptReason,
  hasExactKeys,
  isNonNegativeInt,
  isPlainRecord,
  isPositiveId,
  isValidCiReceiptIdentity,
} from './ci-receipt-shared.js';

/**
 * Reports outgrow the 64 KiB batch input: each of at most 16 entries can
 * carry a bound prior of up to 512 receipts (about 327 KiB), so a
 * worst-case report is about 5.4 MiB. 8 MiB covers that with headroom and
 * stays finite.
 */
export const CI_RECEIPT_SELECT_MAX_INPUT_BYTES = 8 * 1024 * 1024;

export type CiReceiptSelectReportParse =
  | { ok: true; entries: CiReceiptAwaitBatchEntry[] }
  | { ok: false; reason: string };

/** Parse and cross-validate a whole batch report before any selection. */
export function parseCiReceiptAwaitBatchReport(text: string): CiReceiptSelectReportParse {
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return { ok: false, reason: 'not_json' }; }
  if (!isPlainRecord(doc) || !hasExactKeys(doc, CI_RECEIPT_REPORT_KEYS)) {
    return { ok: false, reason: 'unknown_or_missing_fields' };
  }
  if (doc['version'] !== 1) return { ok: false, reason: 'unsupported_version' };
  if (typeof doc['timedOut'] !== 'boolean' || typeof doc['aborted'] !== 'boolean'
    || !isPositiveId(doc['total']) || doc['total'] > CI_RECEIPT_AWAIT_BATCH_MAX_TARGETS
    || !isNonNegativeInt(doc['bound']) || !isNonNegativeInt(doc['failed']) || !isNonNegativeInt(doc['notStarted'])
    || doc['bound'] + doc['failed'] + doc['notStarted'] !== doc['total']
    || !Array.isArray(doc['entries']) || doc['entries'].length !== doc['total']) {
    return { ok: false, reason: 'counts_inconsistent' };
  }
  const seen = new Set<string>();
  const entries: CiReceiptAwaitBatchEntry[] = [];
  const tally = { bound: 0, failed: 0, 'not-started': 0 };
  for (const row of doc['entries']) {
    if (!isPlainRecord(row) || !hasExactKeys(row, CI_RECEIPT_ENTRY_KEYS) || !isValidCiReceiptIdentity(row)
      || typeof row['outcome'] !== 'string' || !CI_RECEIPT_OUTCOMES.has(row['outcome'])) {
      return { ok: false, reason: 'entry_invalid' };
    }
    const outcome = row['outcome'] as CiReceiptAwaitBatchOutcome;
    const reason = row['reason'];
    const consistent = outcome === 'bound'
      ? isPlainRecord(row['prior']) && reason === null
      : row['prior'] === null && typeof reason === 'string' && reason.length >= 1 && reason.length <= CI_RECEIPT_MAX_REASON;
    if (!consistent) return { ok: false, reason: 'outcome_prior_inconsistent' };
    const key = ciReceiptTargetKey(row);
    if (seen.has(key)) return { ok: false, reason: 'duplicate_entry' };
    seen.add(key);
    tally[outcome] += 1;
    entries.push(row as unknown as CiReceiptAwaitBatchEntry);
  }
  if (tally.bound !== doc['bound'] || tally.failed !== doc['failed'] || tally['not-started'] !== doc['notStarted']) {
    return { ok: false, reason: 'counts_inconsistent' };
  }
  return { ok: true, entries };
}

export type CiReceiptSelectResult =
  | { ok: true; prior: CiResumePrior }
  | { ok: false; reason: string; untrusted?: boolean };

/**
 * Select by all four exact identity fields. At most one entry can match a
 * validated report; the match must be bound and pass parseCiResumePrior.
 * `untrusted` marks evidence the report contradicted — treat it like
 * malformed input, not an unavailable target.
 */
export function selectCiReceiptPrior(
  entries: readonly CiReceiptAwaitBatchEntry[],
  target: CiReceiptAwaitBatchTarget,
): CiReceiptSelectResult {
  const tag = `${target.repo} run ${target.run} attempt ${target.attempt} artifact "${cleanCiReceiptReason(target.artifactName)}"`;
  const matches = entries.filter((e) => ciReceiptTargetKey(e) === ciReceiptTargetKey(target));
  if (matches.length === 0) return { ok: false, reason: `no entry matches ${tag}` };
  if (matches.length > 1) return { ok: false, reason: `${matches.length} entries match ${tag}`, untrusted: true };
  const entry = matches[0]!;
  if (entry.outcome !== 'bound') {
    return { ok: false, reason: `entry ${entry.outcome}${entry.reason ? `: ${cleanCiReceiptReason(entry.reason)}` : ''}` };
  }
  try {
    return { ok: true, prior: parseCiResumePrior(entry.prior) };
  } catch (error) {
    return { ok: false, untrusted: true,
      reason: `bound prior is invalid: ${cleanCiReceiptReason(error instanceof Error ? error.message : String(error))}` };
  }
}
