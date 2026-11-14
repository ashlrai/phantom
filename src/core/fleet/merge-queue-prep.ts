/** Local-only lookahead for merge-batch. Never updates a PR branch or publishes. */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { MAX_FILES_PER_PR, planMergeBatches, type MergeBatchPr } from './merge-batch.js';

export interface MergeQueuePreparation {
  number: number;
  headSha: string;
  /** Earlier overlapping merges must land before this result is reusable. */
  after: number[];
}

/** Bounded lookahead; incomplete snapshots and draft/blocked PRs never prepare. */
export function planMergeQueuePreparation(prs: readonly MergeBatchPr[], limit = 3): MergeQueuePreparation[] {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 16) throw new Error('lookahead must be 0..16');
  const plan = planMergeBatches({ prs });
  const byNumber = new Map(prs.map(pr => [pr.number, pr]));
  const earlier = new Set<number>();
  const result: MergeQueuePreparation[] = [];
  for (const batch of plan.batches) {
    for (const member of batch.prs) {
      const pr = byNumber.get(member.number)!;
      if (result.length < limit && !pr.isDraft && pr.mergeStateStatus !== 'BLOCKED'
        && pr.files.length > 0 && pr.files.length < MAX_FILES_PER_PR
        && pr.headSha !== null && /^[0-9a-f]{40}$/i.test(pr.headSha)) {
        result.push({ number: pr.number, headSha: pr.headSha,
          after: member.overlaps.filter(number => earlier.has(number)) });
      }
      earlier.add(member.number);
    }
  }
  return result;
}

export interface PreparationResult {
  number: number;
  state: 'ready' | 'deferred' | 'stale' | 'conflict' | 'failed';
  baseSha: string;
  headSha: string;
  /** Local rehearsal commit only; never a replacement for required checks. */
  preparedSha?: string;
}

export type PreparationGit = (args: string[], cwd: string) => Promise<string>;
const exec = promisify(execFile);
const git: PreparationGit = async (args, cwd) => {
  const { stdout } = await exec('git', args, { cwd, timeout: 60_000, maxBuffer: 1024 * 1024 });
  return stdout.trim();
};

/**
 * Fetch immutable PR heads into FETCH_HEAD, then rehearse against an explicit
 * base in detached disposable worktrees. Shared-file successors are fetched
 * but deferred until their predecessors land; speculative rebases against the
 * old base would immediately become stale. Caller must serialize repository
 * fetches and revalidate base/head identities before using any result.
 * Errors contain no git output (remote diagnostics can contain credentials).
 */
export async function prepareMergeQueue(input: {
  cwd: string;
  baseSha: string;
  preparations: readonly MergeQueuePreparation[];
  git?: PreparationGit;
}): Promise<PreparationResult[]> {
  if (!/^[0-9a-f]{40}$/i.test(input.baseSha) || input.preparations.length > 16
    || input.preparations.some(pr => !Number.isSafeInteger(pr.number) || pr.number < 1
      || !/^[0-9a-f]{40}$/i.test(pr.headSha))) throw new Error('invalid preparation identities');
  const run = input.git ?? git;
  const results: PreparationResult[] = [];
  for (const pr of input.preparations) {
    const result: PreparationResult = { number: pr.number, baseSha: input.baseSha, headSha: pr.headSha, state: 'failed' };
    let directory: string | undefined;
    let added = false;
    try {
      await run(['fetch', '--no-tags', 'origin', `refs/pull/${pr.number}/head`], input.cwd);
      const fetched = await run(['rev-parse', 'FETCH_HEAD'], input.cwd);
      if (fetched !== pr.headSha) result.state = 'stale';
      else if (pr.after.length > 0) result.state = 'deferred';
      else {
        directory = await mkdtemp(join(tmpdir(), 'phantom-merge-prep-'));
        await run(['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', directory, pr.headSha], input.cwd);
        added = true;
        try {
          // Disable hooks and signing: preparation must not invoke repository hooks.
          await run(['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false',
            'rebase', '--no-autostash', '--no-update-refs', '--no-rebase-merges', input.baseSha], directory);
          result.preparedSha = await run(['rev-parse', 'HEAD'], directory);
          result.state = 'ready';
        } catch {
          // Distinguish content conflicts from missing objects/config/other failures.
          const unmerged = await run(['diff', '--name-only', '--diff-filter=U'], directory);
          result.state = unmerged.length > 0 ? 'conflict' : 'failed';
        }
      }
    } catch {
      result.state = 'failed';
    } finally {
      if (directory !== undefined) {
        // Do not remove the directory if git cannot unregister its worktree.
        if (added) await run(['worktree', 'remove', '--force', directory], input.cwd);
        await rm(directory, { recursive: true, force: true });
      }
    }
    results.push(result);
  }
  return results;
}
