import { CiResumeInputsError } from '../core/fleet/ci-resume-inputs.js';
import { artifactNameField } from '../core/fleet/ci-receipt-discovery.js';
import {
  awaitCiReceipt, CI_RECEIPT_AWAIT_DEFAULT_POLL_MS, CI_RECEIPT_AWAIT_DEFAULT_TIMEOUT_MS,
  CI_RECEIPT_AWAIT_MAX_POLL_MS, CI_RECEIPT_AWAIT_MAX_TIMEOUT_MS, CI_RECEIPT_AWAIT_MIN_POLL_MS,
} from '../core/fleet/ci-receipt-await.js';
import { isAwaitMs } from '../core/fleet/needs-mason-answer-await.js';
import type { GitRunner } from '../core/verse/git-ops.js';

const USAGE = 'usage: ashlr fleet ci-receipt-await --repo owner/name --run ID --attempt N --artifact-name NAME [--timeout-ms N] [--poll-ms N] [--json]';
const HELP = `${USAGE}
\`ci-receipt-await\` waits for one explicitly named receipts artifact on one
exact run attempt, then prints its receipts.json as a validated CiResumePrior
document on stdout — feed it to \`ashlr fleet ci-resume-inputs --prior\`.
Diagnostics go to stderr; stdout is the document alone.

Pending is proven by evidence, never by matching error text. Each poll is a
bounded GET of the exact attempt's metadata plus the run's artifact list:
only a positively observed running/queued attempt whose artifact is still
absent sleeps and retries. A completed attempt with the artifact missing
ends unavailable; duplicate, expired, malformed or mismatched evidence is
terminal, and another attempt is never substituted for the one named.

Once the artifact exists it is bound by the same discover path as
\`ci-receipt-discover\`: run metadata, artifact metadata and the attempt's
actual jobs are re-read, receipts are cross-bound to them and producer
inputsDigests are preserved verbatim — never recomputed. One observation is
in flight at a time and a read that outlives the deadline is reported
honestly. --timeout-ms is bounded at one hour (default
${CI_RECEIPT_AWAIT_DEFAULT_TIMEOUT_MS}); --poll-ms is a positive interval of
at least ${CI_RECEIPT_AWAIT_MIN_POLL_MS}ms (default ${CI_RECEIPT_AWAIT_DEFAULT_POLL_MS}).
Timeout and abort exit nonzero with empty stdout.

Read-only: every call is a GET metadata/listing read plus a bounded archive
download; there are no POSTs, no workflow dispatch and no check mutation.`;

const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const idNum = (v: string | undefined): number | null =>
  v !== undefined && /^\d+$/.test(v) && Number.isSafeInteger(Number(v)) && Number(v) >= 1 ? Number(v) : null;
const boundedMs = (v: string | undefined, max: number): number | null =>
  v !== undefined && /^\d+$/.test(v) && isAwaitMs(Number(v), max) ? Number(v) : null;

export interface FleetCiReceiptAwaitDeps {
  gh?: GitRunner;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}

/** Bounded artifact wait for resume-from-failure; stdout is the prior document only. */
export async function cmdFleetCiReceiptAwait(args: string[], deps: FleetCiReceiptAwaitDeps = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(HELP); return 0; }
  const values = new Map<string, string>();
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) { json = true; continue; }
    if (!['--repo', '--run', '--attempt', '--artifact-name', '--timeout-ms', '--poll-ms'].includes(arg)
      || values.has(arg) || !args[i + 1] || args[i + 1]!.startsWith('--')) {
      process.stderr.write(`${USAGE}\n`); return 2;
    }
    values.set(arg, args[++i]!);
  }
  const repo = values.get('--repo') ?? '';
  const run = idNum(values.get('--run'));
  const attempt = idNum(values.get('--attempt'));
  const artifactName = artifactNameField(values.get('--artifact-name'));
  const timeoutMs = values.has('--timeout-ms')
    ? boundedMs(values.get('--timeout-ms'), CI_RECEIPT_AWAIT_MAX_TIMEOUT_MS) : CI_RECEIPT_AWAIT_DEFAULT_TIMEOUT_MS;
  const pollMs = values.has('--poll-ms')
    ? boundedMs(values.get('--poll-ms'), CI_RECEIPT_AWAIT_MAX_POLL_MS) : CI_RECEIPT_AWAIT_DEFAULT_POLL_MS;
  if (!REPO.test(repo) || repo.split('/')[0]!.endsWith('-') || repo.split('/')[0]!.includes('--')
    || repo.endsWith('/.') || repo.endsWith('/..') || run === null || attempt === null
    || artifactName === null || artifactName.startsWith('-')
    || timeoutMs === null || pollMs === null || pollMs < CI_RECEIPT_AWAIT_MIN_POLL_MS) {
    process.stderr.write(`Invalid arguments. ${USAGE}\n`); return 2;
  }
  try {
    const { prior, diagnostics } = await awaitCiReceipt(
      { repo, run, attempt, artifactName, timeoutMs, pollMs, signal: deps.signal },
      { gh: deps.gh, now: deps.now, sleep: deps.sleep });
    for (const line of diagnostics) process.stderr.write(`ci-receipt-await: ${line}\n`);
    console.log(json ? JSON.stringify(prior) : JSON.stringify(prior, null, 2));
    return 0;
  } catch (error) {
    if (error instanceof CiResumeInputsError) {
      process.stderr.write(`ci-receipt-await: ${error.message}\n`); return 1;
    }
    throw error;
  }
}
