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
import { stripVTControlCharacters } from 'node:util';
import { scrubSecrets } from '../util/scrub.js';
import { parseCiResumePrior, type CiResumePrior } from './ci-resume-inputs.js';
import { artifactNameField } from './ci-receipt-discovery.js';
import {
  CI_RECEIPT_AWAIT_BATCH_MAX_TARGETS,
  type CiReceiptAwaitBatchEntry,
  type CiReceiptAwaitBatchOutcome,
  type CiReceiptAwaitBatchTarget,
} from './ci-receipt-await-batch.js';

/**
 * Reports outgrow the 64 KiB batch input: each of at most 16 entries can
 * carry a bound prior of up to 512 receipts (about 327 KiB), so a
 * worst-case report is about 5.4 MiB. 8 MiB covers that with headroom and
 * stays finite.
 */
export const CI_RECEIPT_SELECT_MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_REASON = 200;
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const REPORT_KEYS = ['version', 'total', 'bound', 'failed', 'notStarted', 'timedOut', 'aborted', 'entries'];
const ENTRY_KEYS = ['repo', 'run', 'attempt', 'artifactName', 'outcome', 'prior', 'reason'];
const OUTCOMES = new Set<string>(['bound', 'failed', 'not-started']);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const exactKeys = (v: Record<string, unknown>, keys: readonly string[]): boolean => {
  const k = Object.keys(v);
  return k.length === keys.length && keys.every((x) => k.includes(x));
};
const int = (v: unknown, min: number): v is number => Number.isSafeInteger(v) && (v as number) >= min;
const validRepo = (v: unknown): v is string => typeof v === 'string' && REPO.test(v)
  && !v.split('/')[0]!.endsWith('-') && !v.split('/')[0]!.includes('--')
  && !v.endsWith('/.') && !v.endsWith('/..');
const validIdentity = (v: Record<string, unknown>): v is Record<string, unknown> & CiReceiptAwaitBatchTarget =>
  validRepo(v['repo']) && int(v['run'], 1) && int(v['attempt'], 1)
  && artifactNameField(v['artifactName']) === v['artifactName']
  && !(v['artifactName'] as string).startsWith('-');

/** Same exact-identity key as the batch input: repo case-insensitive, the rest literal. */
const identity = (t: CiReceiptAwaitBatchTarget): string =>
  `${t.repo.toLowerCase()}\0${t.run}\0${t.attempt}\0${t.artifactName}`;

const clean = (value: string): string =>
  // eslint-disable-next-line no-control-regex
  scrubSecrets(stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ''))
    .replace(/[\r\n]+/g, ' ').slice(0, MAX_REASON);

export type CiReceiptSelectReportParse =
  | { ok: true; entries: CiReceiptAwaitBatchEntry[] }
  | { ok: false; reason: string };

/** Parse and cross-validate a whole batch report before any selection. */
export function parseCiReceiptAwaitBatchReport(text: string): CiReceiptSelectReportParse {
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return { ok: false, reason: 'not_json' }; }
  if (!isRecord(doc) || !exactKeys(doc, REPORT_KEYS)) return { ok: false, reason: 'unknown_or_missing_fields' };
  if (doc['version'] !== 1) return { ok: false, reason: 'unsupported_version' };
  if (typeof doc['timedOut'] !== 'boolean' || typeof doc['aborted'] !== 'boolean'
    || !int(doc['total'], 1) || (doc['total'] as number) > CI_RECEIPT_AWAIT_BATCH_MAX_TARGETS
    || !int(doc['bound'], 0) || !int(doc['failed'], 0) || !int(doc['notStarted'], 0)
    || (doc['bound'] as number) + (doc['failed'] as number) + (doc['notStarted'] as number) !== doc['total']
    || !Array.isArray(doc['entries']) || doc['entries'].length !== doc['total']) {
    return { ok: false, reason: 'counts_inconsistent' };
  }
  const seen = new Set<string>();
  const entries: CiReceiptAwaitBatchEntry[] = [];
  const tally = { bound: 0, failed: 0, 'not-started': 0 };
  for (const row of doc['entries']) {
    if (!isRecord(row) || !exactKeys(row, ENTRY_KEYS) || !validIdentity(row)
      || !OUTCOMES.has(String(row['outcome']))) {
      return { ok: false, reason: 'entry_invalid' };
    }
    const outcome = row['outcome'] as CiReceiptAwaitBatchOutcome;
    const reason = row['reason'];
    const consistent = outcome === 'bound'
      ? isRecord(row['prior']) && reason === null
      : row['prior'] === null && typeof reason === 'string' && reason.length >= 1 && reason.length <= MAX_REASON;
    if (!consistent) return { ok: false, reason: 'outcome_prior_inconsistent' };
    const key = identity(row);
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
  const tag = `${target.repo} run ${target.run} attempt ${target.attempt} artifact "${clean(target.artifactName)}"`;
  const matches = entries.filter((e) => identity(e) === identity(target));
  if (matches.length === 0) return { ok: false, reason: `no entry matches ${tag}` };
  if (matches.length > 1) return { ok: false, reason: `${matches.length} entries match ${tag}`, untrusted: true };
  const entry = matches[0]!;
  if (entry.outcome !== 'bound') {
    return { ok: false, reason: `entry ${entry.outcome}${entry.reason ? `: ${clean(entry.reason)}` : ''}` };
  }
  try {
    return { ok: true, prior: parseCiResumePrior(entry.prior) };
  } catch (error) {
    return { ok: false, untrusted: true,
      reason: `bound prior is invalid: ${clean(error instanceof Error ? error.message : String(error))}` };
  }
}
