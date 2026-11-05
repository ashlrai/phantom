/**
 * Retry-manifest planner for the RESUME-FROM-FAILURE and t1626u batching
 * orders (RQ-PHX-RECEIPTBATCHREPLAN05SSK1). A recovery session that holds a
 * partially completed ci-receipt-await-batch report turns it back into an
 * exact {version:1,targets:[...]} stdin document — the same envelope the
 * await-batch reads — without refetching already bound receipts and without
 * hand-editing JSON.
 *
 * The whole report is validated before a manifest is produced: the version,
 * the exact top-level and per-entry field sets, every entry's
 * repo/run/attempt/artifactName identity through the SAME
 * parseCiReceiptAwaitBatchInput validator the await-batch applies to its own
 * input (which also refuses duplicate exact identities), outcome/prior
 * consistency (a bound entry carries a validated CiResumePrior and no
 * reason; a failed or not-started entry carries no prior), the aggregate
 * counts and the timedOut/aborted flags the real producer cannot disagree
 * with. A report that fails any check yields no manifest at all.
 *
 * Routing uses outcome alone — diagnostic reason text is never inspected —
 * and the manifest carries only the four identity fields: priors and
 * reasons are never echoed. Failed and not-started entries keep their
 * input order; bound entries never retry. An all-bound report is terminal:
 * the manifest is the same envelope with an empty target list and there is
 * nothing to pipe back. Read-only: no network, no files, no workflow
 * writes, no receipt changes.
 */
import { parseCiResumePrior } from './ci-resume-inputs.js';
import {
  CI_RECEIPT_AWAIT_BATCH_MAX_TARGETS,
  parseCiReceiptAwaitBatchInput,
  type CiReceiptAwaitBatchTarget,
} from './ci-receipt-await-batch.js';

const OUTCOMES = new Set(['bound', 'failed', 'not-started']);
const REPORT_KEYS = ['version', 'total', 'bound', 'failed', 'notStarted', 'timedOut', 'aborted', 'entries'];
const ENTRY_KEYS = ['repo', 'run', 'attempt', 'artifactName', 'outcome', 'prior', 'reason'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

const hasKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((k) => actual.includes(k));
};

export type CiReceiptBatchReplanParse =
  | { ok: true; targets: CiReceiptAwaitBatchTarget[]; total: number }
  | { ok: false; reason: string };

/**
 * Validate a captured ci-receipt-await-batch report and rebuild the retry
 * manifest: one {repo,run,attempt,artifactName} per failed or not-started
 * entry, in input order, so a nonempty manifest can be piped verbatim into
 * `fleet ci-receipt-await-batch --stdin`. Bound entries are excluded; an
 * all-bound report returns an empty list — terminal, nothing left to wait
 * on. Any malformed or internally inconsistent field refuses the whole
 * document rather than emitting a partial manifest.
 */
export function parseCiReceiptBatchReplanInput(text: string): CiReceiptBatchReplanParse {
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return { ok: false, reason: 'not_json' }; }
  if (!isRecord(doc)) return { ok: false, reason: 'not_object' };
  if (!hasKeys(doc, REPORT_KEYS)) return { ok: false, reason: 'unknown_or_missing_fields' };
  if (doc.version !== 1) return { ok: false, reason: 'unsupported_version' };
  if (!isCount(doc.total) || !isCount(doc.bound) || !isCount(doc.failed) || !isCount(doc.notStarted)
    || typeof doc.timedOut !== 'boolean' || typeof doc.aborted !== 'boolean') {
    return { ok: false, reason: 'counts_invalid' };
  }
  if (!Array.isArray(doc.entries) || doc.entries.length > CI_RECEIPT_AWAIT_BATCH_MAX_TARGETS) {
    return { ok: false, reason: 'entries_invalid' };
  }
  const entries = doc.entries;
  if (entries.length !== doc.total) return { ok: false, reason: 'count_mismatch' };

  // Outcome is the only routing signal; reason text is validated for shape
  // but never read for a decision and never echoed.
  let bound = 0; let notStarted = 0;
  const valid: Record<string, unknown>[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || !hasKeys(entry, ENTRY_KEYS)
      || typeof entry.outcome !== 'string' || !OUTCOMES.has(entry.outcome)) {
      return { ok: false, reason: 'entry_invalid' };
    }
    valid.push(entry);
    if (entry.outcome === 'bound') {
      bound += 1;
      if (entry.reason !== null || entry.prior === null) {
        return { ok: false, reason: 'entry_inconsistent' };
      }
      try {
        const prior = parseCiResumePrior(entry.prior);
        if (typeof entry.repo === 'string' && prior.repo.toLowerCase() !== entry.repo.toLowerCase()) {
          return { ok: false, reason: 'prior_invalid' };
        }
      } catch { return { ok: false, reason: 'prior_invalid' }; }
    } else {
      if (entry.outcome === 'not-started') notStarted += 1;
      if (entry.prior !== null
        || (entry.reason !== null && typeof entry.reason !== 'string')) {
        return { ok: false, reason: 'entry_inconsistent' };
      }
    }
  }

  const failed = entries.length - bound - notStarted;
  if (doc.bound !== bound || doc.failed !== failed || doc.notStarted !== notStarted) {
    return { ok: false, reason: 'count_mismatch' };
  }
  // The producer sets timedOut/aborted only when the batch broke early, and
  // a break is exactly what leaves not-started entries behind.
  if ((doc.timedOut && doc.aborted) || (doc.timedOut || doc.aborted) !== (notStarted > 0)) {
    return { ok: false, reason: 'flags_inconsistent' };
  }

  // The shared validator owns the identity rules and the duplicate check.
  if (valid.length === 0) return { ok: true, targets: [], total: 0 };
  const identities = valid.map((e) => (
    { repo: e.repo, run: e.run, attempt: e.attempt, artifactName: e.artifactName }
  ));
  const parsed = parseCiReceiptAwaitBatchInput(JSON.stringify({ version: 1, targets: identities }));
  if (!parsed.ok) return parsed;
  return {
    ok: true, total: valid.length,
    targets: parsed.targets.filter((_, i) => valid[i]!.outcome !== 'bound'),
  };
}
