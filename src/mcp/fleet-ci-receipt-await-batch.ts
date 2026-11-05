/**
 * fleet_ci_receipt_await_batch — wait for a bounded batch of explicitly
 * named receipts artifacts across repositories in one call, returning each
 * bound target's validated CiResumePrior document for
 * `fleet_ci_resume_inputs` — the RESUME-FROM-FAILURE order and the t1626u
 * batching order — through the isolated fleet MCP server. A shell-free
 * recovery session blocks on the whole batch at once instead of spawning
 * one session per repository.
 *
 * Delegates to awaitCiReceiptBatch — the same bounded batch waiter as
 * `phm fleet ci-receipt-await-batch`, never a second poller or artifact
 * binder. The entire targets document and the timeout/poll timings are
 * validated before anything touches the network, reusing the core parser
 * and bounds; targets then wait strictly in input order with at most one
 * read in flight under one shared deadline that is never refreshed per
 * target. A bound entry carries its exact repo/run/attempt/artifact
 * identity and validated prior with producer inputsDigests preserved
 * verbatim; a terminal failure is recorded beside its exact identity and
 * the batch moves on while time remains; targets the deadline or
 * cancellation never reached are explicit not-started entries — a prior
 * is never fabricated and never substituted from another entry.
 *
 * Read-only GitHub evidence: every call is a GET metadata/listing read
 * plus a bounded archive download — the tool never reruns CI, posts a
 * status or check, dispatches a workflow, writes a receipt or authorizes
 * reuse. No caller executable, cwd, environment, filesystem path or API
 * route is accepted; timeout, cancellation and invalid evidence stay
 * honest per-entry outcomes, never fabricated priors.
 */
import {
  awaitCiReceiptBatch,
  CI_RECEIPT_AWAIT_BATCH_MAX_DIAGNOSTICS,
  CI_RECEIPT_AWAIT_BATCH_MAX_INPUT_BYTES,
  parseCiReceiptAwaitBatchInput,
  type CiReceiptAwaitBatchDeps,
  type CiReceiptAwaitBatchReport,
  type CiReceiptAwaitBatchTarget,
} from '../core/fleet/ci-receipt-await-batch.js';
import {
  CI_RECEIPT_AWAIT_DEFAULT_POLL_MS, CI_RECEIPT_AWAIT_DEFAULT_TIMEOUT_MS,
  CI_RECEIPT_AWAIT_MAX_POLL_MS, CI_RECEIPT_AWAIT_MAX_TIMEOUT_MS, CI_RECEIPT_AWAIT_MIN_POLL_MS,
} from '../core/fleet/ci-receipt-await.js';
import { isAwaitMs } from '../core/fleet/needs-mason-answer-await.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const KEYS = new Set(['targets', 'timeoutMs', 'pollMs']);

export interface FleetCiReceiptAwaitBatchArgs {
  /**
   * Exact repo/run/attempt/artifact identities, waited on in input order;
   * duplicate exact identities are refused. Serialized as the version-1
   * targets document the CLI reads on --stdin, capped at
   * CI_RECEIPT_AWAIT_BATCH_MAX_INPUT_BYTES (64 KiB) before parsing.
   */
  targets: CiReceiptAwaitBatchTarget[];
  /** One shared deadline for the whole batch, at most CI_RECEIPT_AWAIT_MAX_TIMEOUT_MS (one hour). */
  timeoutMs: number;
  /** Poll interval, CI_RECEIPT_AWAIT_MIN_POLL_MS..CI_RECEIPT_AWAIT_MAX_POLL_MS. */
  pollMs: number;
}

export interface FleetCiReceiptAwaitBatchV1 {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
  note: string;
  /**
   * The shared batch report, verbatim: totals, timedOut/aborted flags and
   * one entry per input target in input order — exact identity, outcome,
   * the validated CiResumePrior when bound (pass it to
   * fleet_ci_resume_inputs as `prior`), and a bounded sanitized reason
   * otherwise. failed/not-started entries carry prior:null.
   */
  report: CiReceiptAwaitBatchReport;
  /** Bounded poll/binding evidence lines, newest preserved on truncation. */
  diagnostics: string[];
}

const NOTE = 'Bounded wait for a bounded batch of explicitly named receipts artifacts on exact GitHub run attempts through the shared awaitCiReceiptBatch waiter — the same sequential single-read polling and discover-path binding as `phm fleet ci-receipt-await-batch`, never a second poller — under one shared deadline that is never refreshed per target. Each bound entry returns its own validated CiResumePrior document for fleet_ci_resume_inputs with producer inputsDigests preserved verbatim; a terminal failure or a target the deadline or cancellation never reached is reported honestly beside its exact identity — a prior is never fabricated or borrowed from another entry. Read-only GitHub evidence: every call is a GET metadata/listing read plus a bounded archive download; the tool never reruns CI, posts a status or check, dispatches a workflow, writes a receipt or authorizes reuse.';

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. Unknown
 * keys (including any caller cwd, path, root, executable, environment,
 * runner or API route), a missing or out-of-range target list, malformed
 * or duplicate exact identities, a serialized targets document over the
 * CLI's 64 KiB stdin cap, and non-integer or out-of-bound millisecond
 * timings are all refused before the reader — and before any gh work —
 * runs. The targets document is serialized exactly as the version-1
 * document the CLI reads on --stdin and validated by the same
 * parseCiReceiptAwaitBatchInput, never a second schema. Omitted
 * timeoutMs/pollMs take the shared defaults.
 */
export function parseFleetCiReceiptAwaitBatchArgs(
  args: Record<string, unknown>,
): FleetCiReceiptAwaitBatchArgs | null {
  const { targets, timeoutMs, pollMs } = args;
  const timeout = timeoutMs === undefined ? CI_RECEIPT_AWAIT_DEFAULT_TIMEOUT_MS : timeoutMs;
  const poll = pollMs === undefined ? CI_RECEIPT_AWAIT_DEFAULT_POLL_MS : pollMs;
  if (Object.keys(args).some((key) => !KEYS.has(key))
    || !isAwaitMs(timeout, CI_RECEIPT_AWAIT_MAX_TIMEOUT_MS)
    || !isAwaitMs(poll, CI_RECEIPT_AWAIT_MAX_POLL_MS) || poll < CI_RECEIPT_AWAIT_MIN_POLL_MS) {
    return null;
  }
  let serialized: string;
  try { serialized = JSON.stringify({ version: 1, targets }); }
  catch { return null; }
  if (Buffer.byteLength(serialized, 'utf8') > CI_RECEIPT_AWAIT_BATCH_MAX_INPUT_BYTES) return null;
  const parsed = parseCiReceiptAwaitBatchInput(serialized);
  if (!parsed.ok) return null;
  return { targets: parsed.targets, timeoutMs: timeout, pollMs: poll };
}

const boundedDiagnostics = (lines: string[]): string[] =>
  lines.length <= CI_RECEIPT_AWAIT_BATCH_MAX_DIAGNOSTICS ? lines
    : [`… ${lines.length - CI_RECEIPT_AWAIT_BATCH_MAX_DIAGNOSTICS + 1} earlier poll lines omitted`,
      ...lines.slice(-(CI_RECEIPT_AWAIT_BATCH_MAX_DIAGNOSTICS - 1))];

/**
 * One bounded batch wait through the shared awaitCiReceiptBatch waiter
 * with the server-owned gh runner; request cancellation rides the
 * waiter's signal and is reported honestly (aborted:true plus per-entry
 * not-started records), never thrown away or converted into priors.
 * Partial failure, deadline exhaustion and cancellation stay structured
 * per-entry outcomes. Only the validated report and bounded scrubbed
 * diagnostics cross this boundary, under the shared public-JSON scrub.
 */
export async function readFleetCiReceiptAwaitBatch(
  input: FleetCiReceiptAwaitBatchArgs,
  signal?: AbortSignal,
  deps: CiReceiptAwaitBatchDeps = {},
): Promise<FleetCiReceiptAwaitBatchV1> {
  const { report, diagnostics } = await awaitCiReceiptBatch(input.targets,
    { timeoutMs: input.timeoutMs, pollMs: input.pollMs, signal }, deps);
  return sanitizePublicJson({
    schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
    generatedAt: new Date().toISOString(), note: NOTE,
    report, diagnostics: boundedDiagnostics(diagnostics),
  }) as FleetCiReceiptAwaitBatchV1;
}
