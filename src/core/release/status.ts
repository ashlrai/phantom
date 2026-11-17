import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getLocalReleaseStatus, type ReleaseSummary } from '../fleet/release-chain-status.js';
export { getLocalReleaseStatus } from '../fleet/release-chain-status.js';
import { AUTONOMY_REPOS } from './autonomy-audit.js';

export interface ReleaseStatusRow {
  repo: string;
  defaultBranch: string | null;
  latestTag: string | null;
  ageDays: number | null;
  unreleasedCommits: number | null;
}
export interface ReleaseStatusReport { schema: 'phantom.release-status.v2'; repos: ReleaseStatusRow[]; release: ReleaseSummary }
export interface ReleaseStatusDeps { root?: string; repos?: readonly string[]; now?: number; repoPath?: string; runsDir?: string; cadenceMinutes?: number }
/** Local refs can be stale; missing or incomplete evidence is reported as null. */
export async function getReleaseStatus(deps: ReleaseStatusDeps = {}): Promise<ReleaseStatusReport> {
  const root = deps.root ?? join(homedir(), 'Projects', 'ashlrai');
  const repos = (deps.repos ?? AUTONOMY_REPOS).map((name): ReleaseStatusRow => {
    const path = join(root, name);
    const git = (...args: string[]): string | null => {
      try { return execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim() || null; }
      catch { return null; }
    };
    const empty: ReleaseStatusRow = { repo: `ashlrai/${name}`, defaultBranch: null, latestTag: null, ageDays: null, unreleasedCommits: null };
    if (!existsSync(join(path, '.git'))) return empty;
    const remoteHead = git('symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD');
    const defaultBranch = remoteHead?.startsWith('origin/') ? remoteHead.slice(7) : null;
    const tag = git('for-each-ref', '--sort=-creatordate', '--count=1', '--format=%(refname:strip=2)%09%(creatordate:unix)', 'refs/tags');
    const [latestTag, seconds] = tag?.split('\t') ?? [];
    const timestamp = seconds && /^\d+$/.test(seconds) ? Number(seconds) * 1000 : NaN;
    const ageDays = Number.isFinite(timestamp) ? Math.max(0, Math.floor(((deps.now ?? Date.now()) - timestamp) / 86400000)) : null;
    const count = latestTag && remoteHead && git('rev-parse', '--is-shallow-repository') === 'false'
      ? git('rev-list', '--count', `refs/tags/${latestTag}..refs/remotes/${remoteHead}`) : null;
    return { ...empty, defaultBranch, latestTag: latestTag ?? null, ageDays,
      unreleasedCommits: count !== null && /^\d+$/.test(count) && Number.isSafeInteger(Number(count)) ? Number(count) : null };
  });
  return { schema: 'phantom.release-status.v2', repos, release: await getLocalReleaseStatus(deps) };
}

export function formatReleaseStatus(report: ReleaseStatusReport): string {
  const r = report.release;
  return `Published: ${r.latestPublishedTag ?? 'unknown'} at ${r.publishedAt ?? 'unknown'}\nSigned assets: ${r.signedAssets === null ? 'unknown' : r.signedAssets ? 'complete' : 'missing'}; updater HTTP: ${r.updaterHttp ?? 'unknown'} (recorded ${r.recordedAt ?? 'unknown'})\nMerged PRs since tag: ${r.mergedPrsSinceTag ?? 'unknown'}\nNext: ${r.nextCandidate.version ?? 'unknown'}; earliest ${r.nextCandidate.eta ?? 'unknown'}\nAutorun rc: ${r.autorun.rc ?? 'unknown'}; ${r.autorun.reason ?? 'Reason: unknown (log unavailable or no Reason line)'}`;
}
