/** Bounded, read-only branch containment evidence against a freshly fetched base. */
import { defaultGitRunner, type GitRunner } from '../verse/git-ops.js';

export type BranchEvidence =
  | { state: 'ok'; baseSha: string; branches: { name: string; ahead: number; contained: boolean }[] }
  | { state: 'unknown'; reason: string };

export async function gitOnlyLanded(options: { repoDir?: string; git?: GitRunner; fetch?: boolean } = {}): Promise<BranchEvidence> {
  if (!options.fetch) return { state: 'unknown', reason: 'base not refreshed' };
  const runner = options.git ?? defaultGitRunner;
  const git = (args: string[]) => runner('git', args, { cwd: options.repoDir ?? process.cwd(), timeoutMs: 10_000, maxStdoutBytes: 65536 });
  // FETCH_HEAD identifies the exact fetched commit without changing the worktree or remote refs.
  const shallow = await git(['rev-parse', '--is-shallow-repository']);
  if (shallow.code !== 0 || shallow.stdout.trim() !== 'false') return { state: 'unknown', reason: 'history unavailable' };
  const refreshed = await git(['fetch', '--no-tags', 'origin', 'master']);
  if (refreshed.code !== 0) return { state: 'unknown', reason: 'base refresh failed' };
  const base = await git(['rev-parse', '--verify', 'FETCH_HEAD^{commit}']);
  const sha = base.stdout.trim();
  if (base.code !== 0 || !/^[a-f0-9]{40,64}$/i.test(sha)) return { state: 'unknown', reason: 'base unavailable' };
  const refs = await git(['for-each-ref', '--count=101', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin']);
  if (refs.code !== 0 || refs.truncated) return { state: 'unknown', reason: 'branches unavailable' };
  const names = refs.stdout.split(/\r?\n/).filter(Boolean).filter(n => n !== 'refs/remotes/origin/HEAD');
  if (names.length > 100) return { state: 'unknown', reason: 'branch limit exceeded' };
  const branches: { name: string; ahead: number; contained: boolean }[] = [];
  for (const name of names) {
    const count = await git(['rev-list', '--count', `${sha}..${name}`]);
    const value = count.stdout.trim();
    const ahead = Number(value);
    if (count.code !== 0 || !/^\d+$/.test(value) || !Number.isSafeInteger(ahead)) return { state: 'unknown', reason: 'branch comparison failed' };
    branches.push({ name, ahead, contained: ahead === 0 });
  }
  return { state: 'ok', baseSha: sha, branches };
}
