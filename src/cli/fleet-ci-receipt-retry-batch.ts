/**
 * Retry previously failed or not-started targets from a
 * `ci-receipt-await-batch` report — the RESUME-FROM-FAILURE and t1626u
 * batching orders.
 *
 * stdin must be the previous version-1 batch report (max 64 KiB):
 * {"version":1,"total":N,"bound":N,"failed":N,"notStarted":N,"timedOut":bool,"aborted":bool,"entries":[...]}.
 *
 * Failed and not-started entries are selected (in input order) and
 * deferred once to awaitCiReceiptBatch under a shared per-retry
 * deadline. Bound entries cause zero network reads. The output is the
 * same batch report schema — a further retry is pipeable. When no
 * unresolved targets remain, a documented empty successful report is
 * emitted without calling the non-empty waiter.
 *
 * Exit: 0 all bound or empty, 1 unresolved, 2 invalid input.
 * stdout: single JSON report. stderr: diagnostics.
 */
import {
  retryCiReceiptBatch,
  CI_RECEIPT_RETRY_MAX_INPUT_BYTES,
  parseCiReceiptRetryBatchInput,
} from '../core/fleet/ci-receipt-retry-batch.js';
import {
  CI_RECEIPT_AWAIT_DEFAULT_POLL_MS,
  CI_RECEIPT_AWAIT_MAX_POLL_MS,
  CI_RECEIPT_AWAIT_MAX_TIMEOUT_MS,
  CI_RECEIPT_AWAIT_MIN_POLL_MS,
} from '../core/fleet/ci-receipt-await.js';
import { isAwaitMs } from '../core/fleet/needs-mason-answer-await.js';
import type { GitRunner } from '../core/verse/git-ops.js';

const USAGE = 'usage: ashlr fleet ci-receipt-retry-batch --stdin --timeout-ms N [--poll-ms N] [--json]';
const HELP = `${USAGE}

Reads one version-1 batch report on --stdin and retries only the
previously failed and not-started targets. Bound entries cause zero
reads. stdout is one JSON report (the retry batch report); diagnostics
go to stderr.

Unknown report fields or malformed counts are rejected rather than
silently discarded. Duplicate identities are rejected.

Exit: 0 all bound or empty, 1 unresolved, 2 invalid input.`;

const boundedMs = (v: string | undefined, max: number): number | null =>
  v !== undefined && /^\d+$/.test(v) && isAwaitMs(Number(v), max) ? Number(v) : null;

export interface FleetCiReceiptRetryBatchDeps {
  input?: AsyncIterable<string | Uint8Array>;
  gh?: GitRunner;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}

async function readStdin(input: AsyncIterable<string | Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > CI_RECEIPT_RETRY_MAX_INPUT_BYTES) throw new Error('input too large');
    chunks.push(buffer);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

/** Bounded retry of failed / not-started targets from a previous batch report. */
export async function cmdFleetCiReceiptRetryBatch(
  args: string[], deps: FleetCiReceiptRetryBatchDeps = {},
): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(HELP); return 0; }
  const invalid = (detail: string): number => {
    process.stderr.write(`Invalid input: ${detail}. ${USAGE}\n`); return 2;
  };
  const values = new Map<string, string>();
  let stdin = false; let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--stdin' && !stdin) { stdin = true; continue; }
    if (arg === '--json' && !json) { json = true; continue; }
    if (!['--timeout-ms', '--poll-ms'].includes(arg) || values.has(arg)
      || !args[i + 1] || args[i + 1]!.startsWith('--')) {
      return invalid('unexpected_argument');
    }
    values.set(arg, args[++i]!);
  }
  const timeoutMs = boundedMs(values.get('--timeout-ms'), CI_RECEIPT_AWAIT_MAX_TIMEOUT_MS);
  const pollMs = values.has('--poll-ms')
    ? boundedMs(values.get('--poll-ms'), CI_RECEIPT_AWAIT_MAX_POLL_MS)
    : CI_RECEIPT_AWAIT_DEFAULT_POLL_MS;
  if (!stdin) return invalid('missing_stdin_flag');
  if (timeoutMs === null || pollMs === null || pollMs < CI_RECEIPT_AWAIT_MIN_POLL_MS) {
    return invalid('invalid_flags');
  }
  const input = deps.input ?? process.stdin;
  if (deps.input === undefined && (input as { isTTY?: boolean }).isTTY === true) {
    return invalid('stdin_must_be_a_pipe');
  }
  let text: string;
  try { text = await readStdin(input); }
  catch (error) {
    return invalid(error instanceof Error && error.message === 'input too large'
      ? 'input_too_large' : 'input_unreadable');
  }
  const parsed = parseCiReceiptRetryBatchInput(text);
  if (!parsed.ok) return invalid(parsed.reason);
  const { targets } = parsed;
  const result = await retryCiReceiptBatch(targets, {
    timeoutMs, pollMs, signal: deps.signal,
  }, { gh: deps.gh, now: deps.now, sleep: deps.sleep });
  for (const line of result.diagnostics) process.stderr.write(`${line}\n`);
  // Emit the retry report as stdout (the same batch report schema).
  console.log(json ? JSON.stringify(result.report) : JSON.stringify(result.report, null, 2));
  return result.report.failed + result.report.notStarted === 0 ? 0 : 1;
}
