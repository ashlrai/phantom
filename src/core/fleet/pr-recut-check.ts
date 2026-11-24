/** Read-only recut preflight; reuse the fleet's content and patch containment proof. */
import { tmpdir } from 'node:os';
import type { CloudGh } from '../cloud/pr-actions.js';
import { defaultGitRunner } from '../verse/git-ops.js';
import { inspectDirtyLanded, withScratchRepo, type DirtyLandedPr } from './dirty-landed-inspect.js';

export interface PrRecutCheckDeps { gh?: CloudGh; remote?: string }
export interface PrRecutCheckReport {
  schema: 'pr.recut-check.v1';
  repo: string;
  pr: number;
  alreadyOnMaster: boolean | null;
  alreadyOnMasterFiles: string[] | null;
  remainingFiles: string[] | null;
  evidence: DirtyLandedPr | null;
  next: string;
}

export function validRecutIdentity(pr: number, repo: string): boolean {
  return Number.isSafeInteger(pr) && pr > 0
    && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repo);
}

export async function checkPrRecut(pr: number, repo = 'ashlrai/phantom', deps: PrRecutCheckDeps = {}): Promise<PrRecutCheckReport> {
  if (!validRecutIdentity(pr, repo)) throw new Error('invalid PR identity');
  let evidence: DirtyLandedPr | null = null;
  try {
    const args = ['pr', 'view', String(pr), '--repo', repo, '--json', 'number,headRefOid,baseRefName'];
    const read = deps.gh ? await deps.gh(args) : await defaultGitRunner('gh', args,
      { cwd: tmpdir(), timeoutMs: 60_000, maxStdoutBytes: 1024 * 1024 });
    const ok = 'ok' in read ? read.ok : read.code === 0 && !read.timedOut && !read.truncated;
    if (ok) {
      const row: unknown = JSON.parse(read.stdout);
      if (row && typeof row === 'object' && 'number' in row && row.number === pr
        && 'baseRefName' in row && row.baseRefName === 'master'
        && 'headRefOid' in row && typeof row.headRefOid === 'string' && /^[0-9a-f]{40}$/.test(row.headRefOid)) {
        const headSha = row.headRefOid;
        evidence = await withScratchRepo(dir => inspectDirtyLanded(dir,
          { number: pr, title: '', headSha, baseRef: 'master', mergeable: '', mergeStateStatus: '' },
          deps.remote ?? `https://github.com/${repo}.git`));
      }
    }
  } catch { /* Unavailable or malformed evidence must never skip work. */ }
  const proof = evidence?.class === 'unknown' ? null : evidence;
  const alreadyOnMaster = proof ? proof.class === 'landed' : null;
  return {
    schema: 'pr.recut-check.v1', repo, pr, alreadyOnMaster,
    alreadyOnMasterFiles: proof?.landedPaths ?? null,
    remainingFiles: proof?.remainingPaths ?? null, evidence,
    next: alreadyOnMaster === true ? 'Already on master; skip this recut.'
      : proof ? 'Recut only the remaining files; preserve missing or conflicting work.'
        : 'Source evidence is unavailable; keep this recut and check the PR source.',
  };
}
