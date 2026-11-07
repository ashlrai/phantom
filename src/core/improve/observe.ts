/**
 * Post-merge observation: records when a registered proposal's PR merged and
 * whether a later commit on the default branch reverted it. A revert turns the
 * outcome into a regression for leverage and proposer comparisons, so a change
 * that measured well but did not hold stops earning credit.
 *
 * A revert is recognised by git's own revert message ("This reverts commit
 * <merge sha>") or GitHub's revert-PR body ("Reverts <owner/repo>#<number>"),
 * in commits after the merge on the default branch of a local checkout.
 * A merge counts only once its commit is on the default branch: a PR merged
 * into a feature branch has not landed yet. A revert of the revert re-lands
 * the change, and the outcome earns its credit back.
 */
import { credentialExecFileSync as execFileSync } from '../integrations/secrets.js';
import type { CloudTaskV1 } from '../cloud/types.js';
import type { LedgerEvent, ProposalOutcome } from './outcomes.js';

export type ObserveExec = (cmd: string, args: string[], cwd: string) => string;
const realExec: ObserveExec = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
const GIT = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
const SHA = /^[0-9a-f]{40}$/;

/** Whether `sha` is on `ref`; a commit git does not know yet is not. */
function onBranch(exec: ObserveExec, cwd: string, sha: string, ref: string): boolean {
  try { exec('git', [...GIT, 'merge-base', '--is-ancestor', sha, ref], cwd); return true; } catch { return false; }
}

/** Whether one commit body reverts `mergeSha` (or, with a repository, its PR `number`). */
export function revertsCommitBody(body: string, mergeSha: string, repository: string, number: number): boolean {
  const byPr = repository === '' ? null : new RegExp(`\\bReverts ${repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}#${number}\\b`, 'i');
  return body.includes(`This reverts commit ${mergeSha}`) || byPr?.test(body) === true;
}

/** The first commit in `log` that reverts `mergeSha` (or, with a repository, its PR `number`). */
export function revertOf(log: string, mergeSha: string, repository: string, number: number): string | null {
  for (const entry of log.split('\x1e')) {
    const [sha, body = ''] = entry.trim().split('\x1f');
    if (!sha || !SHA.test(sha)) continue;
    if (revertsCommitBody(body, mergeSha, repository, number)) return sha;
  }
  return null;
}

/** New observation events for `outcomes`, given a checkout whose origin is their repository. */
export function observeOutcomes(outcomes: readonly ProposalOutcome[], repoDir: string, defaultBranch: string, exec: ObserveExec = realExec): { events: LedgerEvent[]; errors: string[] } {
  const events: LedgerEvent[] = [];
  const errors: string[] = [];
  let fetched = false;
  const fetch = () => { if (!fetched) { exec('git', [...GIT, 'fetch', '--no-tags', 'origin', `+refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`], repoDir); fetched = true; } };
  const head = `refs/remotes/origin/${defaultBranch}`;
  const logs = new Map<string, string>();
  const logAfter = (sha: string) => {
    let log = logs.get(sha);
    if (log === undefined) { log = exec('git', [...GIT, 'log', '--format=%H%x1f%B%x1e', `${sha}..${head}`], repoDir); logs.set(sha, log); }
    return log;
  };
  for (const o of outcomes) {
    if (!o.pr) continue;
    try {
      if (o.reverted) {
        // Re-landed: a later default-branch commit reverts the revert.
        fetch();
        const reland = revertOf(logAfter(o.reverted.sha), o.reverted.sha, '', 0);
        if (reland) events.push({ type: 'observed', proposalId: o.proposalId, observation: 'merged', sha: reland });
        continue;
      }
      let mergeSha = o.merged?.sha ?? null;
      if (!mergeSha) {
        const raw = JSON.parse(exec('gh', ['pr', 'view', String(o.pr.number), '--repo', o.pr.repository, '--json', 'state,mergeCommit'], repoDir)) as { state?: string; mergeCommit?: { oid?: string } | null };
        if (raw.state !== 'MERGED' || !raw.mergeCommit?.oid || !SHA.test(raw.mergeCommit.oid)) continue;
        fetch();
        if (!onBranch(exec, repoDir, raw.mergeCommit.oid, head)) continue;
        mergeSha = raw.mergeCommit.oid;
        events.push({ type: 'observed', proposalId: o.proposalId, observation: 'merged', sha: mergeSha });
      }
      fetch();
      const revert = revertOf(logAfter(mergeSha), mergeSha, o.pr.repository, o.pr.number);
      if (revert) events.push({ type: 'observed', proposalId: o.proposalId, observation: 'reverted', sha: revert });
    } catch (err) {
      errors.push(`${o.proposalId}: ${(err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 200)}`);
    }
  }
  return { events, errors };
}

/** A merged cloud task whose revert state changed: reverted by `revertedBy`, or re-landed (null). */
export interface CloudRevertChange { taskId: string; revertedBy: string | null }

/**
 * The same revert rules for merged cloud tasks in `repository` whose merge
 * commit the tracker recorded. A task merged before that evidence existed has
 * no merge sha and is left alone (unknown, not "held").
 */
export function observeCloudReverts(tasks: readonly CloudTaskV1[], repository: string, repoDir: string, defaultBranch: string, exec: ObserveExec = realExec): { changes: CloudRevertChange[]; errors: string[] } {
  const changes: CloudRevertChange[] = [];
  const errors: string[] = [];
  const head = `refs/remotes/origin/${defaultBranch}`;
  const mine = tasks.filter((t) => t.state === 'merged' && t.pr && t.outcome?.mergeSha && t.repo.toLowerCase() === repository.toLowerCase());
  if (mine.length === 0) return { changes, errors };
  try {
    exec('git', [...GIT, 'fetch', '--no-tags', 'origin', `+refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`], repoDir);
  } catch (err) {
    return { changes, errors: [`fetch: ${(err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 200)}`] };
  }
  for (const t of mine) {
    const mergeSha = t.outcome!.mergeSha!;
    const prior = t.outcome!.revertedBy ?? null;
    try {
      if (prior) {
        const log = exec('git', [...GIT, 'log', '--format=%H%x1f%B%x1e', `${prior}..${head}`], repoDir);
        if (revertOf(log, prior, '', 0)) changes.push({ taskId: t.id, revertedBy: null });
        continue;
      }
      if (!onBranch(exec, repoDir, mergeSha, head)) continue;
      const log = exec('git', [...GIT, 'log', '--format=%H%x1f%B%x1e', `${mergeSha}..${head}`], repoDir);
      const revert = revertOf(log, mergeSha, t.repo, t.pr!.number);
      if (revert) changes.push({ taskId: t.id, revertedBy: revert });
    } catch (err) {
      errors.push(`${t.id}: ${(err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 200)}`);
    }
  }
  return { changes, errors };
}
