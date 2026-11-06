import {
  CI_RECEIPT_AWAIT_BATCH_MAX_INPUT_BYTES,
  CI_RECEIPT_AWAIT_BATCH_MAX_TARGETS,
} from '../core/fleet/ci-receipt-await-batch.js';
import { parseCiReceiptBatchReplanInput } from '../core/fleet/ci-receipt-batch-replan.js';

const USAGE = 'usage: ashlr fleet ci-receipt-batch-replan --stdin [--json]';
const HELP = `${USAGE}
\`ci-receipt-batch-replan\` turns a captured ci-receipt-await-batch report
back into an exact retry manifest — the RESUME-FROM-FAILURE and t1626u
batching orders — so a recovery session can re-wait only the receipts that
never bound, without refetching bound receipts or hand-editing JSON. Feed
one UTF-8 JSON report (max ${CI_RECEIPT_AWAIT_BATCH_MAX_INPUT_BYTES} bytes, at most
${CI_RECEIPT_AWAIT_BATCH_MAX_TARGETS} entries) on --stdin: the stdout document the
await-batch produced, with its per-entry identities, outcomes and counts.

The whole report is validated before a manifest is produced: the version,
the exact field sets, every entry's repo/run/attempt/artifactName identity
through the same input validator the await-batch applies (duplicates are
rejected), outcome/prior consistency, the aggregate counts and the
timedOut/aborted flags. Invalid input exits 2 with no manifest. Routing
uses outcome alone — reason text is never read for a decision — and the
manifest carries only the four identity fields: priors and reasons are
never echoed.

stdout is exactly {"version":1,"targets":[...]} — failed and not-started
entries in input order, bound entries excluded — so a nonempty manifest
pipes straight into \`ashlr fleet ci-receipt-await-batch --stdin\` with no
transformation. An all-bound report emits the same envelope with
"targets":[] and exits 0: that is terminal, no retry is needed, and it is
not input the await-batch accepts (its one-target minimum is unchanged).
Diagnostics go to stderr. exit: 0 manifest produced (empty or not),
2 invalid arguments or input.

Read-only: no network, no files, no workflow writes, no receipt changes.`;

export interface FleetCiReceiptBatchReplanDeps {
  input?: AsyncIterable<string | Uint8Array>;
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

/** Report → retry manifest; stdout is the single JSON document, diagnostics stderr. */
export async function cmdFleetCiReceiptBatchReplan(
  args: string[], deps: FleetCiReceiptBatchReplanDeps = {},
): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(HELP); return 0; }
  const invalid = (detail: string): number => {
    process.stderr.write(`Invalid input: ${detail}. ${USAGE}\n`); return 2;
  };
  let stdin = false; let json = false;
  for (const arg of args) {
    if (arg === '--stdin' && !stdin) { stdin = true; continue; }
    if (arg === '--json' && !json) { json = true; continue; }
    return invalid('unexpected_argument');
  }
  if (!stdin) return invalid('missing_stdin_flag');
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
  const parsed = parseCiReceiptBatchReplanInput(text);
  if (!parsed.ok) return invalid(parsed.reason);
  console.log(json
    ? JSON.stringify({ version: 1, targets: parsed.targets })
    : JSON.stringify({ version: 1, targets: parsed.targets }, null, 2));
  process.stderr.write(parsed.targets.length === 0
    ? `ci-receipt-batch-replan: all ${parsed.total} bound — terminal, no retry needed\n`
    : `ci-receipt-batch-replan: ${parsed.targets.length} of ${parsed.total} targets to retry\n`);
  return 0;
}
