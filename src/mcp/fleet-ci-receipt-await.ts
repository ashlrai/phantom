/**
 * fleet_ci_receipt_await — wait for one explicitly named receipts artifact on
 * one exact GitHub Actions run attempt, then return its receipts.json as a
 * validated CiResumePrior document for `fleet_ci_resume_inputs` — the
 * RESUME-FROM-FAILURE order — through the isolated fleet MCP server. A
 * shell-free recovery agent can block on the exact attempt and feed the
 * returned `prior` field straight into the resume planner without a shell, a
 * checkout path or workflow access.
 *
 * Delegates to awaitCiReceipt — the same bounded evidence waiter as
 * `phm fleet ci-receipt-await`, never a second poller or artifact binder.
 * Pending is proven by evidence, never by matching error text: each
 * observation is a bounded GET of the exact attempt's metadata plus the
 * run's artifact list through the server-owned gh runner, and only a
 * positively observed running/queued attempt whose named artifact is still
 * absent may sleep and retry. Once the artifact exists it is bound through
 * the merged discover path — run metadata, artifact metadata and the
 * attempt's actual jobs re-read, receipts cross-bound to them and producer
 * inputsDigests preserved verbatim, never recomputed. A completed attempt
 * without the artifact, duplicates, expiry and malformed or mismatched
 * evidence are terminal tool errors, never a fabricated prior.
 *
 * Read-only GitHub evidence: every call is a GET metadata/listing read plus
 * a bounded archive download — the tool never reruns CI, posts a status or
 * check, dispatches a workflow, writes a receipt or authorizes reuse. No
 * caller executable, cwd, environment, filesystem path or API route is
 * accepted; timeout, cancellation and invalid evidence stay tool errors.
 */
import {
  awaitCiReceipt, CI_RECEIPT_AWAIT_DEFAULT_POLL_MS, CI_RECEIPT_AWAIT_DEFAULT_TIMEOUT_MS,
  CI_RECEIPT_AWAIT_MAX_POLL_MS, CI_RECEIPT_AWAIT_MAX_TIMEOUT_MS, CI_RECEIPT_AWAIT_MIN_POLL_MS,
  type CiReceiptAwaitDeps,
} from '../core/fleet/ci-receipt-await.js';
import { artifactNameField } from '../core/fleet/ci-receipt-discovery.js';
import type { CiResumePrior } from '../core/fleet/ci-resume-inputs.js';
import { isAwaitMs } from '../core/fleet/needs-mason-answer-await.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

/** Diagnostic evidence lines are capped; the newest binder lines always survive. */
export const MAX_FLEET_CI_RECEIPT_DIAGNOSTICS = 200;

const KEYS = new Set(['repo', 'run', 'attempt', 'artifactName', 'timeoutMs', 'pollMs']);
/** Same owner/name shape the ci-receipt CLIs accept — never a path or URL. */
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

export interface FleetCiReceiptAwaitArgs {
  /** GitHub `owner/name` the run belongs to. */
  repo: string;
  /** Exact workflow run id. */
  run: number;
  /** Exact run attempt number; another attempt is never substituted. */
  attempt: number;
  /** Exact artifact name; never guessed or substituted. */
  artifactName: string;
  /** Total wait bound, at most CI_RECEIPT_AWAIT_MAX_TIMEOUT_MS (one hour). */
  timeoutMs: number;
  /** Poll interval, CI_RECEIPT_AWAIT_MIN_POLL_MS..CI_RECEIPT_AWAIT_MAX_POLL_MS. */
  pollMs: number;
}

export interface FleetCiReceiptAwaitV1 {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
  note: string;
  /** The validated CiResumePrior document — pass it to fleet_ci_resume_inputs as `prior`. */
  prior: CiResumePrior;
  /** Bounded poll/binding evidence lines, newest preserved on truncation. */
  diagnostics: string[];
}

const NOTE = 'Bounded wait for one explicitly named receipts artifact on one exact GitHub run attempt through the shared awaitCiReceipt evidence waiter — the same polling and binding path as `phm fleet ci-receipt-await`, never a second poller — returning the validated CiResumePrior document for fleet_ci_resume_inputs with producer inputsDigests preserved verbatim. Read-only GitHub evidence: every call is a GET metadata/listing read plus a bounded archive download; the tool never reruns CI, posts a status or check, dispatches a workflow, writes a receipt or authorizes reuse.';

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. Unknown keys
 * (including any caller cwd, path, root, executable, environment, runner or
 * API route), a malformed repository identity, non-string artifact names,
 * non-integer or unsafe run/attempt numbers and non-integer or out-of-bound
 * millisecond timings are all refused before the reader — and before any gh
 * work — runs. Omitted timeoutMs/pollMs take the shared defaults.
 */
export function parseFleetCiReceiptAwaitArgs(args: Record<string, unknown>): FleetCiReceiptAwaitArgs | null {
  const { repo, run, attempt, artifactName, timeoutMs, pollMs } = args;
  const timeout = timeoutMs === undefined ? CI_RECEIPT_AWAIT_DEFAULT_TIMEOUT_MS : timeoutMs;
  const poll = pollMs === undefined ? CI_RECEIPT_AWAIT_DEFAULT_POLL_MS : pollMs;
  if (Object.keys(args).some((key) => !KEYS.has(key))
    || typeof repo !== 'string' || !REPO.test(repo)
    || repo.split('/')[0]!.endsWith('-') || repo.split('/')[0]!.includes('--')
    || repo.endsWith('/.') || repo.endsWith('/..')
    || typeof run !== 'number' || !Number.isSafeInteger(run) || run < 1
    || typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1
    || typeof artifactName !== 'string' || artifactNameField(artifactName) !== artifactName
    || artifactName.startsWith('-')
    || !isAwaitMs(timeout, CI_RECEIPT_AWAIT_MAX_TIMEOUT_MS)
    || !isAwaitMs(poll, CI_RECEIPT_AWAIT_MAX_POLL_MS) || poll < CI_RECEIPT_AWAIT_MIN_POLL_MS) {
    return null;
  }
  return { repo, run, attempt, artifactName, timeoutMs: timeout, pollMs: poll };
}

const boundedDiagnostics = (lines: string[]): string[] =>
  lines.length <= MAX_FLEET_CI_RECEIPT_DIAGNOSTICS ? lines
    : [`… ${lines.length - MAX_FLEET_CI_RECEIPT_DIAGNOSTICS + 1} earlier poll lines omitted`,
      ...lines.slice(-(MAX_FLEET_CI_RECEIPT_DIAGNOSTICS - 1))];

/**
 * One bounded wait through the shared awaitCiReceipt waiter with the
 * server-owned gh runner; request cancellation rides the waiter's signal.
 * Waiter failures — timeout, abort, completed-without-artifact, duplicate or
 * expired evidence, malformed evidence — propagate so the server reports a
 * sanitized tool error, never a fabricated empty prior. Only the validated
 * prior document and bounded scrubbed diagnostics cross this boundary, under
 * the shared public-JSON scrub.
 */
export async function readFleetCiReceiptAwait(
  input: FleetCiReceiptAwaitArgs,
  signal?: AbortSignal,
  deps: CiReceiptAwaitDeps = {},
): Promise<FleetCiReceiptAwaitV1> {
  const { prior, diagnostics } = await awaitCiReceipt(
    { repo: input.repo, run: input.run, attempt: input.attempt, artifactName: input.artifactName,
      timeoutMs: input.timeoutMs, pollMs: input.pollMs, signal },
    deps);
  return sanitizePublicJson({
    schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
    generatedAt: new Date().toISOString(), note: NOTE,
    prior, diagnostics: boundedDiagnostics(diagnostics),
  }) as FleetCiReceiptAwaitV1;
}
