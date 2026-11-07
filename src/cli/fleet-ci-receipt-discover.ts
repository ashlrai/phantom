import { CiResumeInputsError } from '../core/fleet/ci-resume-inputs.js';
import { artifactNameField, discoverCiReceiptPrior } from '../core/fleet/ci-receipt-discovery.js';
import type { GitRunner } from '../core/verse/git-ops.js';

const USAGE = 'usage: ashlr fleet ci-receipt-discover --repo owner/name --run ID --attempt N --artifact-name NAME [--json]';
const HELP = `${USAGE}
\`ci-receipt-discover\` resolves a receipts artifact by exact name and prints
its receipts.json as a CiResumePrior document on stdout — feed it to
\`ashlr fleet ci-resume-inputs --prior\`. Diagnostics go to stderr.

Discovery: one bounded paginated listing of the run's artifacts must find
exactly one bearer of --artifact-name and it must be nonexpired; its numeric
id is then fetched and bound by the same evidence path as
\`ci-resume-receipts --artifact-id\`. Expired-ambiguity policy: because the
archive is fetched by name, an expired artifact still counts against name
uniqueness — it is never the bearer but always makes a duplicate ambiguous.
Names are never guessed and duplicates are never resolved by recency.

An artifact name alone is no proof of attempt: the binder supplies the run,
attempt and job binding by re-reading run metadata, artifact metadata and the
attempt's actual jobs, and receipts' inputsDigests are preserved verbatim —
never recomputed. Evidence is unavailable, never synthesized, on any
ambiguity or mismatch, and failures exit nonzero with empty stdout.

Read-only: every call is a GET listing/metadata read plus a bounded archive
download; there are no POSTs, no workflow dispatch and no check mutation.`;

const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const idNum = (v: string | undefined): number | null =>
  v !== undefined && /^\d+$/.test(v) && Number.isSafeInteger(Number(v)) && Number(v) >= 1 ? Number(v) : null;

/** Receipt discovery for resume-from-failure; stdout is the prior document only. */
export async function cmdFleetCiReceiptDiscover(args: string[], deps: { gh?: GitRunner } = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(HELP); return 0; }
  const values = new Map<string, string>();
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) { json = true; continue; }
    if (!['--repo', '--run', '--attempt', '--artifact-name'].includes(arg) || values.has(arg)
      || !args[i + 1] || args[i + 1]!.startsWith('--')) {
      process.stderr.write(`${USAGE}\n`); return 2;
    }
    values.set(arg, args[++i]!);
  }
  const repo = values.get('--repo') ?? '';
  const run = idNum(values.get('--run'));
  const attempt = idNum(values.get('--attempt'));
  const artifactName = artifactNameField(values.get('--artifact-name'));
  if (!REPO.test(repo) || repo.split('/')[0]!.endsWith('-') || repo.split('/')[0]!.includes('--')
    || repo.endsWith('/.') || repo.endsWith('/..') || run === null || attempt === null
    || artifactName === null || artifactName.startsWith('-')) {
    process.stderr.write(`Invalid arguments. ${USAGE}\n`); return 2;
  }
  try {
    const { prior, diagnostics } = await discoverCiReceiptPrior(
      { repo, run, attempt, artifactName, gh: deps.gh });
    for (const line of diagnostics) process.stderr.write(`ci-receipt-discover: ${line}\n`);
    console.log(json ? JSON.stringify(prior) : JSON.stringify(prior, null, 2));
    return 0;
  } catch (error) {
    if (error instanceof CiResumeInputsError) {
      process.stderr.write(`ci-receipt-discover: ${error.message}\n`); return 1;
    }
    throw error;
  }
}
