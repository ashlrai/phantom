import {
  awaitCiReceiptBatch,
  CI_RECEIPT_AWAIT_BATCH_MAX_INPUT_BYTES,
  CI_RECEIPT_AWAIT_BATCH_MAX_TARGETS,
  parseCiReceiptAwaitBatchInput,
} from '../core/fleet/ci-receipt-await-batch.js';
import {
  CI_RECEIPT_AWAIT_DEFAULT_POLL_MS,
  CI_RECEIPT_AWAIT_MAX_POLL_MS,
  CI_RECEIPT_AWAIT_MAX_TIMEOUT_MS,
  CI_RECEIPT_AWAIT_MIN_POLL_MS,
} from '../core/fleet/ci-receipt-await.js';
import { isAwaitMs } from '../core/fleet/needs-mason-answer-await.js';
import type { GitRunner } from '../core/verse/git-ops.js';

const USAGE = 'usage: ashlr fleet ci-receipt-await-batch --stdin --timeout-ms N [--poll-ms N] [--json]';
const HELP = `${USAGE}
\`ci-receipt-await-batch\` waits for a bounded batch of explicitly named
receipts artifacts — the RESUME-FROM-FAILURE and t1626u batching orders — so
one recovery session can collect exact run/attempt evidence for up to
${CI_RECEIPT_AWAIT_BATCH_MAX_TARGETS} repositories without spawning a session per
repository. Feed one UTF-8 JSON document (max ${CI_RECEIPT_AWAIT_BATCH_MAX_INPUT_BYTES} bytes) on
--stdin: {"version":1,"targets":[{"repo":"owner/name","run":ID,"attempt":N,"artifactName":"NAME"},...]}.
Unknown keys, malformed fields, out-of-range lists and duplicate exact
identities are all rejected before anything touches the network.

Each target waits through the same awaitCiReceipt evidence path as
\`ci-receipt-await\` — sequential, in input order, at most one read in
flight — under a single batch deadline that is never refreshed per target.
A terminal failure on one target is recorded beside its exact identity and
the batch moves on while time remains; targets the deadline never reached
get explicit "not-started" entries and a prior is never fabricated.
--timeout-ms is required and bounded at one hour; --poll-ms is a positive
interval of at least ${CI_RECEIPT_AWAIT_MIN_POLL_MS}ms (default ${CI_RECEIPT_AWAIT_DEFAULT_POLL_MS}).

stdout is one JSON report: per-entry identities, outcomes, the validated
CiResumePrior documents and bounded sanitized failure reasons. Diagnostics
go to stderr. exit: 0 every target bound, 1 any target failed or not
started, 2 invalid arguments or input.

Read-only: every call is a GET metadata/listing read plus a bounded archive
download; there are no POSTs, no workflow dispatch and no check mutation.`;

const boundedMs = (v: string | undefined, max: number): number | null =>
  v !== undefined && /^\d+$/.test(v) && isAwaitMs(Number(v), max) ? Number(v) : null;

export interface FleetCiReceiptAwaitBatchDeps {
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
    if (bytes > CI_RECEIPT_AWAIT_BATCH_MAX_INPUT_BYTES) throw new Error('input too large');
    chunks.push(buffer);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

/** Bounded batch artifact wait; stdout is the single JSON report, diagnostics stderr. */
export async function cmdFleetCiReceiptAwaitBatch(
  args: string[], deps: FleetCiReceiptAwaitBatchDeps = {},
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
  const parsed = parseCiReceiptAwaitBatchInput(text);
  if (!parsed.ok) return invalid(parsed.reason);
  const { report, diagnostics } = await awaitCiReceiptBatch(parsed.targets,
    { timeoutMs, pollMs, signal: deps.signal },
    { gh: deps.gh, now: deps.now, sleep: deps.sleep });
  for (const line of diagnostics) process.stderr.write(`ci-receipt-await-batch: ${line}\n`);
  console.log(json ? JSON.stringify(report) : JSON.stringify(report, null, 2));
  return report.failed + report.notStarted === 0 ? 0 : 1;
}
