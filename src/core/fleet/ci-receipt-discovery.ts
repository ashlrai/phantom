/**
 * Artifact-name discovery for the RESUME-FROM-FAILURE order: given a
 * repository, run and exact artifact name, resolve the run's single bearer of
 * that name through one bounded paginated `gh api` listing, then hand the
 * numeric artifact id to the existing receipt binder — the same injected
 * runner, the same evidence path, the same CiResumePrior document out.
 *
 * A name alone proves nothing: the binder re-reads run metadata, artifact
 * metadata and the attempt's actual jobs and rejects receipts that do not
 * match them, so discovery supplies lookup only, never authority. Discovery
 * never guesses names, never picks among duplicates — an expired sibling with
 * the same name still makes the name ambiguous because the archive is fetched
 * by name — and never recomputes digests. No POSTs and no workflow dispatch.
 */
import { defaultGitRunner, type GitRunner } from '../verse/git-ops.js';
import { fetchCiResumeReceipts, type CiResumeReceiptsFetch } from './ci-resume-receipts.js';
import {
  CI_LIST_MAX_BYTES,
  failCiResume,
  findSingleRunArtifactBearer,
  parseGhJsonOutput,
  parseRunArtifactRows,
  runGhApi,
} from './ci-receipt-shared.js';

export { artifactNameField } from './ci-receipt-shared.js';

/**
 * Resolve `artifactName` to the run's single live bearer and fetch it through
 * the existing binder. Throws CiResumeInputsError on any unavailable,
 * ambiguous or mismatched evidence; a failure never yields a prior document.
 */
export async function discoverCiReceiptPrior(opts: {
  repo: string; run: number; attempt: number; artifactName: string; gh?: GitRunner;
}): Promise<CiResumeReceiptsFetch> {
  const gh = opts.gh ?? defaultGitRunner;
  const rows = parseRunArtifactRows(parseGhJsonOutput(await runGhApi(gh, ['api', '--paginate', '--slurp',
    `repos/${opts.repo}/actions/runs/${opts.run}/artifacts?per_page=100`], CI_LIST_MAX_BYTES, 'run artifacts'), 'run artifacts'));
  const bearer = findSingleRunArtifactBearer(rows, opts.run, opts.artifactName)
    ?? failCiResume(`run ${opts.run} has no artifact named "${opts.artifactName}"`);
  const found = await fetchCiResumeReceipts(
    { repo: opts.repo, run: opts.run, attempt: opts.attempt, artifactId: bearer.id, gh });
  return { prior: found.prior,
    diagnostics: [`run ${opts.run} artifacts: ${rows.length} listed; "${opts.artifactName}" resolves to artifact ${bearer.id}`,
      ...found.diagnostics] };
}
