import { CiResumeInputsError } from '../core/fleet/ci-resume-inputs.js';
import { fetchCiResumeReceipts } from '../core/fleet/ci-resume-receipts.js';
import type { GitRunner } from '../core/verse/git-ops.js';

const USAGE = 'usage: ashlr fleet ci-resume-receipts --repo owner/name --run ID --attempt N --artifact-id ID [--archive file.zip] [--json]';
const HELP = `${USAGE}

Fetch one explicitly selected GitHub Actions artifact and print its
receipts.json as a CiResumePrior document on stdout — feed it to
\`ashlr fleet ci-resume-inputs --prior\`. Diagnostics go to stderr.

Producer contract: the selected artifact must hold a receipts.json at the
archive root containing a version-1 CiResumePrior document whose repo
matches --repo. Every receipt must carry this run id, this attempt, the
run's head sha, the GitHub job id and that job's actual conclusion for
the same attempt, plus the producer's inputsDigest. Digests are never
recomputed here and the working tree is never read.

This command transports and binds evidence only; it cannot authorize
reuse. Reuse is decided solely by ci-resume-inputs reproducing each
stored inputsDigest from git objects at --base, and by GitHub's own
required checks. Evidence is unavailable — never synthesized — whenever
the run or artifact is missing, expired, mismatched, ambiguous or
oversized, and failures exit nonzero.

Transport: run identity, artifact metadata and the attempt's jobs are
read with \`gh api\`; the archive is fetched with \`gh run download --name\`,
so the artifact name must be unique in the run. When it is not, download
the archive explicitly (\`gh api repos/<repo>/actions/artifacts/<id>/zip >
file.zip\`) and pass --archive. No in-process zip reader dependency exists,
so --archive members are parsed in memory instead: only the exact
receipts.json member is inflated, bounded, and any absolute or
parent-traversing member name rejects the archive.`;

const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const idNum = (v: string | undefined): number | null =>
  v !== undefined && /^\d+$/.test(v) && Number.isSafeInteger(Number(v)) && Number(v) >= 1 ? Number(v) : null;

/** Evidence ingestion for resume-from-failure; stdout is the prior document only. */
export async function cmdFleetCiResumeReceipts(args: string[], deps: { gh?: GitRunner } = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(HELP); return 0; }
  const values = new Map<string, string>();
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) { json = true; continue; }
    if (!['--repo', '--run', '--attempt', '--artifact-id', '--archive'].includes(arg) || values.has(arg)
      || !args[i + 1] || args[i + 1]!.startsWith('--')) {
      process.stderr.write(`${USAGE}\n`); return 2;
    }
    values.set(arg, args[++i]!);
  }
  const repo = values.get('--repo') ?? '';
  const run = idNum(values.get('--run'));
  const attempt = idNum(values.get('--attempt'));
  const artifactId = idNum(values.get('--artifact-id'));
  const archive = values.get('--archive');
  if (!REPO.test(repo) || repo.split('/')[0]!.endsWith('-') || repo.split('/')[0]!.includes('--')
    || repo.endsWith('/.') || repo.endsWith('/..') || run === null || attempt === null || artifactId === null) {
    process.stderr.write(`Invalid arguments. ${USAGE}\n`); return 2;
  }
  try {
    const { prior, diagnostics } = await fetchCiResumeReceipts(
      { repo, run, attempt, artifactId, ...(archive !== undefined ? { archive } : {}), gh: deps.gh });
    for (const line of diagnostics) process.stderr.write(`ci-resume-receipts: ${line}\n`);
    console.log(json ? JSON.stringify(prior) : JSON.stringify(prior, null, 2));
    return 0;
  } catch (error) {
    if (error instanceof CiResumeInputsError) {
      process.stderr.write(`ci-resume-receipts: ${error.message}\n`); return 1;
    }
    throw error;
  }
}
