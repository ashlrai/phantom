/**
 * The landed-sweep without gh: plain-word reasons for a failed gh read, and a
 * git-only "which branches have landed" read for a host where gh is missing,
 * signed out or offline.
 *
 * A branch counts as landed when every one of its commits is reachable from
 * origin/<base> (nothing ahead of it). This is read-only for the repository's
 * work: the only write is `git fetch` refreshing remote-tracking refs.
 */
import { defaultGitRunner, type GitRunner } from '../verse/git-ops.js';

export type GhFailureKind = 'missing' | 'signed-out' | 'offline' | 'error';
export interface GhFailure { kind: GhFailureKind; reason: string }

const firstLine = (text: string): string => (text.split(/\r?\n/).find(line => line.trim() !== '') ?? '').trim().slice(0, 160);

/** Turn a failed gh run into one plain reason. `missing` means the binary never started. */
export function describeGhFailure(run: { stderr: string; missing?: boolean; timedOut?: boolean }): GhFailure {
  if (run.missing) return { kind: 'missing', reason: 'gh not installed' };
  const text = run.stderr;
  if (/gh auth login|not logged in|authentication required|bad credentials|http 401|GH_TOKEN/i.test(text)) return { kind: 'signed-out', reason: 'gh not signed in' };
  if (run.timedOut || /could not resolve host|network is unreachable|connection (refused|reset|timed out)|dial tcp|timeout|no route to host|tls handshake/i.test(text)) {
    return { kind: 'offline', reason: 'network unreachable' };
  }
  return { kind: 'error', reason: `gh failed: ${firstLine(text) || 'no output'}` };
}

export interface GitOnlyBranch { name: string; landed: boolean; ahead: number }
export type GitOnlyResult =
  | { state: 'ok'; base: string; branches: GitOnlyBranch[] }
  | { state: 'skipped'; reason: string }
  | { state: 'failed'; reason: string };

export interface GitOnlyOptions {
  /** The clone to read; defaults to the process working directory. */
  repoDir?: string;
  /** Base branch on origin; fleet PRs all target master. */
  base?: string;
  git?: GitRunner;
}

const GIT_TIMEOUT_MS = 60_000;

export async function gitOnlyLanded(options: GitOnlyOptions = {}): Promise<GitOnlyResult> {
  const cwd = options.repoDir ?? process.cwd();
  const base = options.base ?? 'master';
  const runner = options.git ?? defaultGitRunner;
  const git = (args: string[]) => runner('git', args, { cwd, timeoutMs: GIT_TIMEOUT_MS });

  const inside = await git(['rev-parse', '--git-dir']);
  if (inside.missing) return { state: 'skipped', reason: 'git not installed' };
  if (inside.code !== 0) return { state: 'skipped', reason: `not a git clone: ${cwd}` };

  const fetch = await git(['fetch', '--no-tags', '--quiet', 'origin', base]);
  if (fetch.code !== 0) {
    const text = fetch.timedOut ? 'timed out' : firstLine(fetch.stderr) || 'no output';
    return { state: 'failed', reason: `git fetch failed: ${text}` };
  }

  const refs = await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes/origin']);
  if (refs.code !== 0) return { state: 'failed', reason: `git for-each-ref failed: ${firstLine(refs.stderr) || 'no output'}` };
  const tip = `origin/${base}`;
  const names = [...new Set(refs.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean))]
    .filter(name => name !== base && name !== tip && name !== 'origin' && name !== 'origin/HEAD');

  const branches: GitOnlyBranch[] = [];
  for (const name of names) {
    const count = await git(['rev-list', '--count', `${tip}..${name}`]);
    const ahead = count.code === 0 ? Number(count.stdout.trim()) : NaN;
    if (!Number.isSafeInteger(ahead)) return { state: 'failed', reason: `git rev-list failed for ${name}` };
    branches.push({ name, landed: ahead === 0, ahead });
  }
  return { state: 'ok', base: tip, branches };
}
