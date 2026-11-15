/**
 * Read-only blame for a red default branch: bisect the merges between the last
 * green SHA and the first red SHA and name the first one whose check fails.
 *
 * Merges are the first-parent commits of `good..bad` (squash merges and merge
 * commits both show up there). Each probe checks a merge out in one throwaway
 * detached worktree and runs the check command; exit 0 is green. Nothing is
 * pushed, reverted or reset, and the worktree is removed when the search ends.
 * The bad SHA is taken as red without a probe, which keeps the count at
 * ceil(log2(merges)) check runs.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface MainBlameReport {
  first_bad_sha: string;
  pr_number: number | null;
  pr_title: string;
  author_job_id: string | null;
  checks_run: number;
}

export interface MainBlameInput {
  repo: string;
  good: string;
  bad: string;
  check: string;
  timeoutMs?: number;
}

export interface MainBlameDeps {
  /** Runs git in `cwd` and returns stdout; throws on a non-zero exit. */
  git?: (cwd: string, args: string[]) => string;
  /** Runs the check in `cwd`; true when it exits 0. */
  runCheck?: (cwd: string, command: string, timeoutMs: number) => boolean;
}

export class MainBlameError extends Error {}

export const DEFAULT_CHECK_TIMEOUT_MS = 600_000;

const defaultGit = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });

const defaultRunCheck = (cwd: string, command: string, timeoutMs: number): boolean =>
  spawnSync(command, { cwd, shell: true, stdio: 'ignore', timeout: timeoutMs }).status === 0;

/** Split a merge's subject and body into PR number, title and the job id that authored it. */
export function parseMergeMessage(subject: string, body: string): Pick<MainBlameReport, 'pr_number' | 'pr_title' | 'author_job_id'> {
  const github = /^Merge pull request #(\d+) from \S+/.exec(subject);
  const raw = github ? (body.split('\n').find(l => l.trim()) ?? subject) : subject;
  const suffix = /\s*\(#(\d+)\)\s*$/.exec(raw);
  const prNumber = github ? Number(github[1]) : suffix ? Number(suffix[1]) : null;
  const bridge = /^bridge\(([^)]+)\):\s*/.exec(raw);
  const title = raw.slice(bridge ? bridge[0].length : 0, suffix ? suffix.index : undefined).trim();
  return { pr_number: prNumber, pr_title: title || raw.trim(), author_job_id: bridge ? bridge[1]! : null };
}

export function mainBlame(input: MainBlameInput, deps: MainBlameDeps = {}): MainBlameReport {
  const git = deps.git ?? defaultGit;
  const runCheck = deps.runCheck ?? defaultRunCheck;
  const timeoutMs = input.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const resolve = (ref: string): string => {
    try { return git(input.repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim(); }
    catch { throw new MainBlameError(`cannot find commit "${ref}" in ${input.repo}`); }
  };
  const good = resolve(input.good);
  const bad = resolve(input.bad);
  try { git(input.repo, ['merge-base', '--is-ancestor', good, bad]); }
  catch { throw new MainBlameError('--good must be an ancestor of --bad'); }
  const merges = git(input.repo, ['rev-list', '--first-parent', '--reverse', `${good}..${bad}`]).split('\n').filter(Boolean);
  if (merges.length === 0) throw new MainBlameError('--good and --bad are the same commit: nothing to blame');

  let lo = -1; // last known green index (-1 is the good SHA)
  let hi = merges.length - 1; // first known red index (the bad SHA, taken as red)
  let checksRun = 0;
  if (hi > 0) {
    const dir = mkdtempSync(join(tmpdir(), 'phm-main-blame-'));
    const tree = join(dir, 'tree');
    try {
      git(input.repo, ['worktree', 'add', '--detach', tree, merges[0]!]);
      while (hi - lo > 1) {
        const mid = lo + Math.floor((hi - lo) / 2);
        git(tree, ['checkout', '--detach', '--force', merges[mid]!]);
        checksRun++;
        if (runCheck(tree, input.check, timeoutMs)) lo = mid; else hi = mid;
      }
    } finally {
      try { git(input.repo, ['worktree', 'remove', '--force', tree]); } catch { /* best effort */ }
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const sha = merges[hi]!;
  const [subject = '', ...rest] = git(input.repo, ['show', '-s', '--format=%s%n%b', sha]).split('\n');
  return { first_bad_sha: sha, ...parseMergeMessage(subject, rest.join('\n')), checks_run: checksRun };
}
