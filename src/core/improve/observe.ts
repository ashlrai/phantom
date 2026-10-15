/**
 * Post-merge observation: records when a registered proposal's PR merged and
 * whether a later commit on the default branch reverted it. A revert turns the
 * outcome into a regression for leverage and proposer comparisons, so a change
 * that measured well but did not hold stops earning credit.
 *
 * A revert is recognised by git's own revert message ("This reverts commit
 * <merge sha>") or GitHub's revert-PR body ("Reverts <owner/repo>#<number>"),
 * in commits after the merge on the default branch of a local checkout.
 */
import { execFileSync } from 'node:child_process';
import type { LedgerEvent, ProposalOutcome } from './outcomes.js';

export type ObserveExec = (cmd: string, args: string[], cwd: string) => string;
const realExec: ObserveExec = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
const GIT = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
const SHA = /^[0-9a-f]{40}$/;

export function revertOf(log: string, mergeSha: string, repository: string, number: number): string | null {
  const byPr = new RegExp(`\\bReverts ${repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}#${number}\\b`, 'i');
  for (const entry of log.split('\x1e')) {
    const [sha, body = ''] = entry.trim().split('\x1f');
    if (!sha || !SHA.test(sha)) continue;
    if (body.includes(`This reverts commit ${mergeSha}`) || byPr.test(body)) return sha;
  }
  return null;
}

/** New observation events for `outcomes`, given a checkout whose origin is their repository. */
export function observeOutcomes(outcomes: readonly ProposalOutcome[], repoDir: string, defaultBranch: string, exec: ObserveExec = realExec): { events: LedgerEvent[]; errors: string[] } {
  const events: LedgerEvent[] = [];
  const errors: string[] = [];
  let fetched = false;
  for (const o of outcomes) {
    if (!o.pr || o.reverted) continue;
    try {
      let mergeSha = o.merged?.sha ?? null;
      if (!mergeSha) {
        const raw = JSON.parse(exec('gh', ['pr', 'view', String(o.pr.number), '--repo', o.pr.repository, '--json', 'state,mergeCommit'], repoDir)) as { state?: string; mergeCommit?: { oid?: string } | null };
        if (raw.state !== 'MERGED' || !raw.mergeCommit?.oid || !SHA.test(raw.mergeCommit.oid)) continue;
        mergeSha = raw.mergeCommit.oid;
        events.push({ type: 'observed', proposalId: o.proposalId, observation: 'merged', sha: mergeSha });
      }
      if (!fetched) { exec('git', [...GIT, 'fetch', '--no-tags', 'origin', `+refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`], repoDir); fetched = true; }
      const log = exec('git', [...GIT, 'log', '--format=%H%x1f%B%x1e', `${mergeSha}..refs/remotes/origin/${defaultBranch}`], repoDir);
      const revert = revertOf(log, mergeSha, o.pr.repository, o.pr.number);
      if (revert) events.push({ type: 'observed', proposalId: o.proposalId, observation: 'reverted', sha: revert });
    } catch (err) {
      errors.push(`${o.proposalId}: ${(err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 200)}`);
    }
  }
  return { events, errors };
}
