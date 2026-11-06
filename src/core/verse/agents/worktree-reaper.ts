/**
 * Reclaim finished, opted-in agent worktrees through the normal snapshot
 * archive path. In particular, retry an archive that failed after a merge:
 * the next Checks read reports `merged`, which the merge loop otherwise skips.
 * No filesystem scan or age heuristic can establish that an agent is finished.
 */
import { archiveAgent, type ActionDeps } from './actions.js';
import type { AgentChecksDetail, AgentRecord } from './types.js';
import { readWorkspaceConfig } from './workspace-config.js';

type FinishedWorktreeEvidence = Pick<AgentChecksDetail, 'pr' | 'branch' | 'unavailable'>;

function eligible(deps: ActionDeps, agent: AgentRecord, evidence: FinishedWorktreeEvidence): boolean {
  if (evidence.unavailable !== null || evidence.pr?.state !== 'merged' || !evidence.pr.headSha ||
      !agent.autoMerge || agent.archived || agent.pinned ||
      !agent.workspace || agent.workspace.branch !== evidence.branch || agent.pendingPrompt ||
      (agent.plan.enabled && (agent.plan.state === 'drafting' || agent.plan.state === 'awaiting-approval')) ||
      !agent.sessionId || agent.scripts.some((script) => script.state === 'running')) return false;
  // An unavailable engine/session is unknown activity, never proof of idleness.
  return deps.engine()?.getSession(agent.sessionId)?.status === 'idle';
}

function sameWorkspace(left: AgentRecord, right: AgentRecord): boolean {
  return left.sessionId === right.sessionId && !!left.workspace && !!right.workspace &&
    left.workspace.path === right.workspace.path && left.workspace.rootPath === right.workspace.rootPath &&
    left.workspace.name === right.workspace.name && left.workspace.branch === right.workspace.branch;
}

export async function reapFinishedAgentWorktree(
  deps: ActionDeps,
  observed: AgentRecord,
  evidence: FinishedWorktreeEvidence,
): Promise<AgentRecord> {
  let current = await deps.store.get(observed.id);
  if (!current || !sameWorkspace(current, observed) || !eligible(deps, current, evidence)) return current ?? observed;
  const workspace = current.workspace!;
  const config = (await readWorkspaceConfig(workspace.rootPath)).config;
  // Config reads yield. Do not archive a newly pinned/restored/busy workspace
  // using the stale record from the previous supervisor or filesystem read.
  current = await deps.store.get(observed.id);
  if (!current || !sameWorkspace(current, observed) || !eligible(deps, current, evidence)) return current ?? observed;
  return archiveAgent(deps, current, 'merged', config);
}
