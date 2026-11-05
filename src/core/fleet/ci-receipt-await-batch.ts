/**
 * Bounded sequential batch over awaitCiReceipt for the RESUME-FROM-FAILURE
 * and t1626u batching orders (RQ-PHX-CIRECEIPTAWAITBATCH05SRZ1). One
 * recovery session reads a single bounded JSON document of exact
 * repo/run/attempt/artifact identities and waits for each in turn instead of
 * spawning one session per repository.
 *
 * The whole document is validated before the first read: unknown keys,
 * malformed fields, out-of-range counts and duplicate exact identities are
 * rejected while nothing has touched the network. Then each target waits
 * through the merged awaitCiReceipt — the same evidence polling, the same
 * discover-path binding, the same validated CiResumePrior out — strictly in
 * input order with at most one read in flight.
 *
 * One deadline covers the batch, never refreshed per target: each wait is
 * handed only the time that remains, so a slow target cannot manufacture
 * budget for the next. A terminal failure on one target is recorded beside
 * its exact identity and the batch moves on while time remains; targets the
 * deadline never reached get explicit not-started entries — a prior is
 * never fabricated. Every call is the same GET metadata/listing read plus
 * bounded archive download the single await makes: no POSTs, no workflow
 * dispatch, no check mutation.
 */
import { performance } from 'node:perf_hooks';
import { stripVTControlCharacters } from 'node:util';
import type { GitRunner } from '../verse/git-ops.js';
import { scrubSecrets } from '../util/scrub.js';
import type { CiResumePrior } from './ci-resume-inputs.js';
import { abortableSleep, isAwaitMs } from './needs-mason-answer-await.js';
import { artifactNameField } from './ci-receipt-discovery.js';
import {
  awaitCiReceipt,
  CI_RECEIPT_AWAIT_DEFAULT_POLL_MS,
  CI_RECEIPT_AWAIT_MAX_POLL_MS,
  CI_RECEIPT_AWAIT_MAX_TIMEOUT_MS,
  CI_RECEIPT_AWAIT_MIN_POLL_MS,
} from './ci-receipt-await.js';

/** One bounded stdin document names the whole batch: 64 KiB, at most 16 targets. */
export const CI_RECEIPT_AWAIT_BATCH_MAX_INPUT_BYTES = 64 * 1024;
export const CI_RECEIPT_AWAIT_BATCH_MAX_TARGETS = 16;
/** Batch stderr evidence is capped; the newest binding lines always survive. */
export const CI_RECEIPT_AWAIT_BATCH_MAX_DIAGNOSTICS = 200;
const MAX_REASON = 200;

/** Same owner/name shape the ci-receipt CLIs accept — never a path or URL. */
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

export interface CiReceiptAwaitBatchTarget {
  repo: string; run: number; attempt: number; artifactName: string;
}
export type CiReceiptAwaitBatchOutcome = 'bound' | 'failed' | 'not-started';
export interface CiReceiptAwaitBatchEntry extends CiReceiptAwaitBatchTarget {
  outcome: CiReceiptAwaitBatchOutcome;
  /** The validated CiResumePrior when outcome is 'bound'; null otherwise. */
  prior: CiResumePrior | null;
  /** Bounded sanitized failure reason when not bound; null on success. */
  reason: string | null;
}
export interface CiReceiptAwaitBatchReport {
  version: 1;
  total: number;
  bound: number;
  failed: number;
  notStarted: number;
  /** The shared deadline expired while targets were still waiting to start. */
  timedOut: boolean;
  /** The caller's AbortSignal stopped the batch early. */
  aborted: boolean;
  /** One entry per input target, in input order. */
  entries: CiReceiptAwaitBatchEntry[];
}
export interface CiReceiptAwaitBatchResult {
  report: CiReceiptAwaitBatchReport;
  /** Bounded per-target evidence lines for stderr. */
  diagnostics: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const idNum = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 1;

const validRepo = (repo: unknown): repo is string =>
  typeof repo === 'string' && REPO.test(repo)
  && !repo.split('/')[0]!.endsWith('-') && !repo.split('/')[0]!.includes('--')
  && !repo.endsWith('/.') && !repo.endsWith('/..');

const validTarget = (value: unknown): value is CiReceiptAwaitBatchTarget =>
  isRecord(value) && Object.keys(value).length === 4
  && validRepo(value.repo)
  && idNum(value.run) && idNum(value.attempt)
  && typeof value.artifactName === 'string'
  && artifactNameField(value.artifactName) === value.artifactName
  && !value.artifactName.startsWith('-');

/** Exact identity, case-insensitive on the repo like the evidence binder is. */
const identity = (t: CiReceiptAwaitBatchTarget): string =>
  `${t.repo.toLowerCase()}\0${t.run}\0${t.attempt}\0${t.artifactName}`;

const clean = (value: string): string =>
  // eslint-disable-next-line no-control-regex
  scrubSecrets(stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ''))
    .replace(/[\r\n]+/g, ' ').slice(0, MAX_REASON);

export type CiReceiptAwaitBatchParse =
  | { ok: true; targets: CiReceiptAwaitBatchTarget[] }
  | { ok: false; reason: string };

/**
 * Parse the whole stdin document before anything touches the network.
 * Rejects malformed JSON, unknown or missing fields at either level, an
 * unsupported version, an out-of-range target list, malformed fields and
 * duplicate exact identities.
 */
export function parseCiReceiptAwaitBatchInput(text: string): CiReceiptAwaitBatchParse {
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return { ok: false, reason: 'not_json' }; }
  if (!isRecord(doc)) return { ok: false, reason: 'not_object' };
  const keys = Object.keys(doc);
  if (keys.length !== 2 || !keys.includes('version') || !keys.includes('targets')) {
    return { ok: false, reason: 'unknown_or_missing_fields' };
  }
  if (doc.version !== 1) return { ok: false, reason: 'unsupported_version' };
  if (!Array.isArray(doc.targets)
    || doc.targets.length < 1 || doc.targets.length > CI_RECEIPT_AWAIT_BATCH_MAX_TARGETS) {
    return { ok: false, reason: 'target_count' };
  }
  const seen = new Set<string>();
  const targets: CiReceiptAwaitBatchTarget[] = [];
  for (const entry of doc.targets) {
    if (!validTarget(entry)) return { ok: false, reason: 'target_invalid' };
    const key = identity(entry);
    if (seen.has(key)) return { ok: false, reason: 'duplicate_target' };
    seen.add(key);
    targets.push(entry);
  }
  return { ok: true, targets };
}

export interface CiReceiptAwaitBatchOptions {
  /** Total batch bound shared by every target; at most one hour. */
  timeoutMs: number;
  pollMs?: number;
  signal?: AbortSignal;
  /** Awaited after each settled entry; failures propagate to the caller. */
  onEntry?: (entry: CiReceiptAwaitBatchEntry) => void | Promise<void>;
}
export interface CiReceiptAwaitBatchDeps {
  gh?: GitRunner;
  /** Monotonic milliseconds. */
  now?: () => number;
  /** Resolves after ms or as soon as the signal aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Test seam: defaults to awaitCiReceipt. */
  wait?: typeof awaitCiReceipt;
}

/**
 * Wait for each target in input order under one shared deadline. The bound
 * and target list are re-validated here so a caller that skipped the parser
 * can never queue an unbounded or malformed batch. A target's own failure
 * is recorded — never thrown — and the next target starts only while time
 * remains; entries never fabricate a prior.
 */
export async function awaitCiReceiptBatch(
  targets: readonly CiReceiptAwaitBatchTarget[],
  opts: CiReceiptAwaitBatchOptions,
  deps: CiReceiptAwaitBatchDeps = {},
): Promise<CiReceiptAwaitBatchResult> {
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > CI_RECEIPT_AWAIT_BATCH_MAX_TARGETS
    || !targets.every(validTarget)
    || new Set(targets.map(identity)).size !== targets.length) {
    throw new RangeError('invalid target list');
  }
  const pollMs = opts.pollMs ?? CI_RECEIPT_AWAIT_DEFAULT_POLL_MS;
  if (!isAwaitMs(opts.timeoutMs, CI_RECEIPT_AWAIT_MAX_TIMEOUT_MS)
    || !isAwaitMs(pollMs, CI_RECEIPT_AWAIT_MAX_POLL_MS) || pollMs < CI_RECEIPT_AWAIT_MIN_POLL_MS) {
    throw new RangeError('invalid await parameters');
  }
  const now = deps.now ?? (() => performance.now());
  const sleep = deps.sleep ?? abortableSleep;
  const wait = deps.wait ?? awaitCiReceipt;
  const deadline = now() + opts.timeoutMs;
  const diagnostics: string[] = [];
  const entries: CiReceiptAwaitBatchEntry[] = [];
  let stoppedBy: 'deadline' | 'aborted' | null = null;
  for (const target of targets) {
    if (opts.signal?.aborted) { stoppedBy = 'aborted'; break; }
    const remaining = Math.floor(deadline - now());
    if (remaining < 1) { stoppedBy = 'deadline'; break; }
    try {
      const found = await wait(
        { repo: target.repo, run: target.run, attempt: target.attempt,
          artifactName: target.artifactName, timeoutMs: remaining, pollMs, signal: opts.signal },
        { gh: deps.gh, now, sleep });
      entries.push({ ...target, outcome: 'bound', prior: found.prior, reason: null });
      const tag = `${target.repo} run ${target.run} attempt ${target.attempt}`;
      for (const line of found.diagnostics) diagnostics.push(`${tag}: ${line}`);
    } catch (error) {
      entries.push({ ...target, outcome: 'failed', prior: null,
        reason: clean(error instanceof Error ? error.message : String(error)) });
    }
    await opts.onEntry?.(entries[entries.length - 1]!);
  }
  for (const target of targets.slice(entries.length)) {
    entries.push({ ...target, outcome: 'not-started', prior: null,
      reason: stoppedBy === 'aborted' ? 'batch aborted' : 'batch deadline expired' });
    await opts.onEntry?.(entries[entries.length - 1]!);
  }
  if (diagnostics.length > CI_RECEIPT_AWAIT_BATCH_MAX_DIAGNOSTICS) {
    diagnostics.splice(0, diagnostics.length - CI_RECEIPT_AWAIT_BATCH_MAX_DIAGNOSTICS,
      `${diagnostics.length - CI_RECEIPT_AWAIT_BATCH_MAX_DIAGNOSTICS} earlier lines dropped`);
  }
  const bound = entries.filter(e => e.outcome === 'bound').length;
  const notStarted = entries.filter(e => e.outcome === 'not-started').length;
  return {
    report: {
      version: 1, total: targets.length, bound, notStarted,
      failed: targets.length - bound - notStarted,
      timedOut: stoppedBy === 'deadline', aborted: stoppedBy === 'aborted',
      entries,
    },
    diagnostics,
  };
}
