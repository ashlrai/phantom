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
import { tmpdir } from 'node:os';
import { defaultGitRunner, type GitRunner, type GitRunResult } from '../verse/git-ops.js';
import { scrubSecrets } from '../util/scrub.js';
import { CiResumeInputsError } from './ci-resume-inputs.js';
import { fetchCiResumeReceipts, type CiResumeReceiptsFetch } from './ci-resume-receipts.js';

const TIMEOUT_MS = 30_000;
const LIST_MAX_BYTES = 4 * 1024 * 1024;
const MAX_LIST_ROWS = 2048;
const NAME_MAX = 200;

// Function declaration, not a const arrow: the compiler only propagates
// never-returning CFA narrowing through declared functions.
function fail(message: string): never { throw new CiResumeInputsError(message); }
const record = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const jsonOut = (r: GitRunResult, label: string): unknown => {
  try { return JSON.parse(r.stdout); } catch { fail(`${label} returned malformed JSON`); }
};
export const artifactNameField = (v: unknown): string | null =>
  // eslint-disable-next-line no-control-regex
  typeof v === 'string' && v.length > 0 && v.length <= NAME_MAX && !/[\x00-\x1f\x7f]/.test(v) ? v : null;

async function api(gh: GitRunner, args: string[], maxStdoutBytes: number, label: string): Promise<GitRunResult> {
  let r: GitRunResult;
  try { r = await gh('gh', args, { cwd: tmpdir(), timeoutMs: TIMEOUT_MS, maxStdoutBytes }); }
  catch { throw new CiResumeInputsError(`${label} could not run`); }
  if (r.missing) fail('gh is not installed');
  if (r.timedOut) fail(`${label} timed out`);
  if (r.truncated) fail(`${label} output exceeded its bound`);
  if (r.code !== 0) fail(`${label} failed: ${scrubSecrets((r.stderr.split('\n')[0] ?? '').trim()).slice(0, 160)}`);
  return r;
}

interface ArtifactRow { id: number; name: string; expired: boolean; runId: number | null }

/** Slurped `gh api --paginate --slurp` artifact pages; refuses inconsistent or partial counts. */
function artifactRows(value: unknown): ArtifactRow[] {
  if (!Array.isArray(value) || value.length === 0) fail('run artifacts evidence is malformed');
  const rows: Record<string, unknown>[] = [];
  let total: number | undefined;
  for (const page of value) {
    const p = record(page);
    if (!p || !Number.isSafeInteger(p['total_count']) || (p['total_count'] as number) < 0
      || !Array.isArray(p['artifacts']) || (total !== undefined && total !== p['total_count'])) {
      fail('run artifacts evidence is malformed');
    }
    total = p['total_count'] as number;
    for (const row of p['artifacts'] as unknown[]) rows.push(record(row) ?? fail('run artifacts evidence is malformed'));
  }
  if (total === undefined || rows.length !== total || total > MAX_LIST_ROWS) fail('run artifacts pagination is ambiguous');
  return rows.map((a): ArtifactRow => {
    const wf = a['workflow_run'] === undefined || a['workflow_run'] === null ? null
      : record(a['workflow_run']) ?? fail('run artifacts evidence is malformed');
    const runId = wf === null ? null : Number.isSafeInteger(wf['id']) ? wf['id'] as number
      : fail('run artifacts evidence is malformed');
    if (!Number.isSafeInteger(a['id']) || (a['id'] as number) < 1 || typeof a['expired'] !== 'boolean'
      || artifactNameField(a['name']) === null) fail('run artifacts evidence is malformed');
    return { id: a['id'] as number, name: a['name'] as string, expired: a['expired'] as boolean, runId };
  });
}

/**
 * The name must have exactly one bearer in the run and it must be live.
 * Expired-ambiguity policy: because the archive is fetched by name
 * (`gh run download --name` merges same-named artifacts), an expired sibling
 * still makes the name ambiguous — expired rows never count as the bearer but
 * always count against uniqueness.
 */
function selectArtifactId(rows: ArtifactRow[], run: number, name: string): number {
  const bearers = rows.filter((r) => r.name === name);
  if (bearers.length > 1) fail(`artifact name "${name}" has ${bearers.length} bearers in run ${run}`);
  const only = bearers[0];
  if (!only) fail(`run ${run} has no artifact named "${name}"`);
  if (only.expired) fail(`artifact "${name}" in run ${run} is expired`);
  if (only.runId !== null && only.runId !== run) fail(`artifact "${name}" does not belong to run ${run}`);
  return only.id;
}

/**
 * Resolve `artifactName` to the run's single live bearer and fetch it through
 * the existing binder. Throws CiResumeInputsError on any unavailable,
 * ambiguous or mismatched evidence; a failure never yields a prior document.
 */
export async function discoverCiReceiptPrior(opts: {
  repo: string; run: number; attempt: number; artifactName: string; gh?: GitRunner;
}): Promise<CiResumeReceiptsFetch> {
  const gh = opts.gh ?? defaultGitRunner;
  const rows = artifactRows(jsonOut(await api(gh, ['api', '--paginate', '--slurp',
    `repos/${opts.repo}/actions/runs/${opts.run}/artifacts?per_page=100`], LIST_MAX_BYTES, 'run artifacts'), 'run artifacts'));
  const artifactId = selectArtifactId(rows, opts.run, opts.artifactName);
  const found = await fetchCiResumeReceipts(
    { repo: opts.repo, run: opts.run, attempt: opts.attempt, artifactId, gh });
  return { prior: found.prior,
    diagnostics: [`run ${opts.run} artifacts: ${rows.length} listed; "${opts.artifactName}" resolves to artifact ${artifactId}`,
      ...found.diagnostics] };
}
