import {
  CI_RECEIPT_SELECT_MAX_INPUT_BYTES,
  parseCiReceiptAwaitBatchReport,
  selectCiReceiptPrior,
} from '../core/fleet/ci-receipt-select.js';
import {
  isValidArtifactNameFlag,
  isValidCiRepo,
  parsePositiveIdFlag,
  readBoundedUtf8Input,
} from '../core/fleet/ci-receipt-shared.js';

const USAGE = 'usage: ashlr fleet ci-receipt-select --stdin --repo owner/name --run N --attempt N --artifact-name NAME [--json]';
const HELP = `${USAGE}
\`ci-receipt-select\` extracts exactly one successful prior document from a
ci-receipt-await-batch report — the RESUME-FROM-FAILURE and t1626u orders —
so a recovery agent pulls one exact run's receipts without hand-editing
JSON. Pipe the report (max ${CI_RECEIPT_SELECT_MAX_INPUT_BYTES} bytes) on --stdin
and name the target by all four exact identity fields:

  ashlr fleet ci-receipt-await-batch --stdin --timeout-ms 600000 --json < targets.json \\
    | ashlr fleet ci-receipt-select --stdin --repo ashlrai/phantom --run 991 \\
        --attempt 2 --artifact-name ci-resume-receipts --json > prior.json

Selection is by exact identity only — repo (case-insensitive, like the
evidence binder), run, attempt and artifactName — never array position,
name substring or newest. The whole report is validated first: version,
per-outcome counts, unique identities and outcome/prior consistency;
malformed or oversized input and duplicate flags are rejected before
anything prints. Exactly one matching bound entry must pass the same
parseCiResumePrior validation ci-resume-inputs applies; stdout is then
only that validated prior document — producer digests verbatim — usable
unchanged as the ci-resume-inputs --prior input.

A selected prior is evidence, not a reuse decision: it proves a previous
attempt produced successful receipts, while the resume planner still
decides whether those inputs match the resumed base.

exit: 0 one bound prior selected; 1 the identity is missing, failed or not
started in a valid report; 2 invalid arguments, unreadable or oversized
stdin, or a malformed/inconsistent report. No artifact fetch, network,
files or CI actions.`;

export interface FleetCiReceiptSelectDeps {
  input?: AsyncIterable<string | Uint8Array>;
}

/** Report-to-prior selector; stdout is the single validated prior document, reasons stderr. */
export async function cmdFleetCiReceiptSelect(
  args: string[], deps: FleetCiReceiptSelectDeps = {},
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
    if (!['--repo', '--run', '--attempt', '--artifact-name'].includes(arg) || values.has(arg)
      || !args[i + 1] || args[i + 1]!.startsWith('--')) {
      return invalid('unexpected_argument');
    }
    values.set(arg, args[++i]!);
  }
  const repo = values.get('--repo');
  const run = parsePositiveIdFlag(values.get('--run'));
  const attempt = parsePositiveIdFlag(values.get('--attempt'));
  const artifactName = values.get('--artifact-name');
  if (!stdin) return invalid('missing_stdin_flag');
  if (!isValidCiRepo(repo) || run === null || attempt === null || !isValidArtifactNameFlag(artifactName)) {
    return invalid('invalid_flags');
  }
  const read = await readBoundedUtf8Input(
    deps.input ?? process.stdin, CI_RECEIPT_SELECT_MAX_INPUT_BYTES, deps.input === undefined);
  if (!read.ok) return invalid(read.reason);
  const parsed = parseCiReceiptAwaitBatchReport(read.text);
  if (!parsed.ok) return invalid(`report_${parsed.reason}`);
  const selected = selectCiReceiptPrior(parsed.entries, { repo, run, attempt, artifactName });
  if (!selected.ok) {
    process.stderr.write(`ci-receipt-select: ${selected.reason}\n`);
    return selected.untrusted === true ? 2 : 1;
  }
  console.log(json ? JSON.stringify(selected.prior) : JSON.stringify(selected.prior, null, 2));
  return 0;
}
