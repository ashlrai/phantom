/**
 * Guardian manifest feed.
 *
 * Turns the newest first-parent commits of a repo branch into a manifest that
 * `guardian-verify` (guardian-verify-loop.ts) accepts, so an always-on
 * supervisor can run `guardian-manifest` then `guardian-verify` on a timer and
 * every merge to main gets checked with no hand-assembled input. The feed is
 * observation-only: it reads `git log`, writes one JSON file, and grants no
 * merge, deploy or routing authority.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DetachedPostMergeRunnerInput } from './detached-post-merge-runner.js';
import {
  GUARDIAN_MANIFEST_MAX_ENTRIES,
  GUARDIAN_SHA_RE,
  isValidGuardianBranch,
  isValidGuardianRepoPath,
  sanitizeGuardianText,
  writePrivateAtomic,
} from './guardian-schema.js';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 30_000;
const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface FirstParentCommit {
  sha: string;
  parents: string[];
  subject: string;
}

export type GuardianManifestEntry = Pick<
  DetachedPostMergeRunnerInput,
  'repo' | 'cohortId' | 'proposalId' | 'baseBranch' | 'baseHead' | 'candidateHead' | 'mergeCommit'
>;

/**
 * Pure mapping from first-parent commits (as `git log` emits them, newest
 * first) to manifest entries in oldest-first order. Root commits and merges
 * with more than two parents cannot bind an exact base/candidate pair and are
 * skipped; `mergeCommit` never repeats.
 *
 * For a single-parent (squash or direct) commit the runner's exactMergeBinding
 * rule applies: candidateHead === mergeCommit and baseHead is its only parent.
 * For a two-parent merge baseHead is parent 1 and candidateHead is parent 2.
 */
export function guardianManifestEntries(
  commits: ReadonlyArray<FirstParentCommit>,
  opts: { repo: string; branch: string },
): GuardianManifestEntry[] {
  const cohortId = sanitizeGuardianText(`guardian-${opts.branch}`);
  const seen = new Set<string>();
  const entries: GuardianManifestEntry[] = [];
  for (let i = commits.length - 1; i >= 0; i--) {
    const commit = commits[i]!;
    if (commit.parents.length < 1 || commit.parents.length > 2) continue;
    if (!GUARDIAN_SHA_RE.test(commit.sha) || !commit.parents.every(sha => GUARDIAN_SHA_RE.test(sha))) continue;
    if (seen.has(commit.sha)) continue;
    seen.add(commit.sha);
    const pr = /\(#(\d+)\)\s*$/.exec(commit.subject);
    const candidateHead = commit.parents.length === 2 ? commit.parents[1]! : commit.sha;
    entries.push({
      repo: opts.repo,
      cohortId,
      proposalId: pr ? `pr-${pr[1]}` : `commit-${commit.sha.slice(0, 12)}`,
      baseBranch: opts.branch,
      baseHead: commit.parents[0]!,
      candidateHead,
      mergeCommit: commit.sha,
    });
  }
  return entries;
}

/**
 * Read the newest `limit` first-parent commits of `branch` in `repo`.
 * Uses argv arrays only (no shell), and never reads commit bodies.
 */
export async function readFirstParentCommits(
  repo: string,
  branch: string,
  limit: number,
): Promise<FirstParentCommit[]> {
  if (!isValidGuardianRepoPath(repo) || !isValidGuardianBranch(branch)
    || !Number.isSafeInteger(limit) || limit < 1 || limit > GUARDIAN_MANIFEST_MAX_ENTRIES) {
    throw new Error('invalid guardian-manifest input');
  }
  const { stdout } = await execFileAsync('git', [
    '-c', 'log.showSignature=false', '-C', repo,
    'log', '--first-parent', '-n', String(limit), '--format=%H %P%x09%s', branch,
  ], {
    encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_GIT_OUTPUT_BYTES, windowsHide: true,
  });
  const commits: FirstParentCommit[] = [];
  for (const line of String(stdout).split('\n')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    const [sha, ...parents] = (tab === -1 ? line : line.slice(0, tab)).split(' ').filter(Boolean);
    if (sha === undefined || !GUARDIAN_SHA_RE.test(sha) || !parents.every(shaPart => GUARDIAN_SHA_RE.test(shaPart))) continue;
    commits.push({ sha, parents, subject: tab === -1 ? '' : line.slice(tab + 1) });
  }
  return commits;
}

/**
 * Atomically write the manifest JSON (temp file in the same directory, then
 * rename, mode 0600). The guardian loop requires 1..100 entries, so an empty
 * list is refused rather than written.
 */
export async function writeGuardianManifest(
  path: string,
  entries: ReadonlyArray<GuardianManifestEntry>,
): Promise<number> {
  if (entries.length === 0 || entries.length > GUARDIAN_MANIFEST_MAX_ENTRIES) {
    throw new Error('guardian manifest requires 1 to 100 entries');
  }
  await writePrivateAtomic(path, JSON.stringify(entries, null, 2));
  return entries.length;
}
