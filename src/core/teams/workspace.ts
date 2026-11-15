/** Workspace mutations and their audit records are the same locked append. */
import { assertLocalHuman } from './identity.js';
import {
  parseAccessRequestAction, validHumanMemberId, REPO_NAME_RE,
  type AccessRequestAction, type TeamActor, type TeamEvent,
} from './protocol.js';
import { appendUnlocked, readEvents, withTeamLock } from './store.js';
import { releaseCoordinationBySource } from '../agents/claim-store.js';
import { teamState, type TeamState } from './state.js';

export type WorkspaceAction =
  | AccessRequestAction
  | { type: 'member.removed'; memberId: string };

/**
 * All state-dependent checks for a workspace mutation, returning the event
 * payload on success. Pure: no authority check, no append, no coordination
 * side effects, so a pending access request can be dry-run against any state.
 */
function workspacePayload(state: TeamState, actor: TeamActor, action: WorkspaceAction): Record<string, unknown> {
  if (action.type === 'repo.linked') {
    if (!REPO_NAME_RE.test(action.repo)) throw new Error('repo must be owner/name.');
    const repo = action.repo.toLowerCase();
    if (state.repos.includes(repo)) throw new Error('Repository already linked.');
    return { repo };
  }
  if (action.type !== 'member.invited' && action.type !== 'member.role-changed' && action.type !== 'member.removed') throw new Error('Unknown workspace action.');
  if (!validHumanMemberId(action.memberId)) throw new Error('memberId must be human:<name>.');
  const member = state.members.find(m => m.id === action.memberId);
  if (action.type === 'member.invited') {
    if (member) throw new Error('Member already exists.');
    return { memberId: action.memberId, role: 'member' };
  }
  if (!member || member.kind !== 'human') throw new Error(`Unknown human member ${action.memberId}. Run: phm team view --team ${state.team} --json`);
  if (member.id === actor.id) {
    throw new Error(action.type === 'member.removed'
      ? 'You cannot remove yourself; ask another owner/admin.'
      : 'Use another owner/admin to change your role.');
  }
  if (member.role === 'owner') {
    throw new Error(action.type === 'member.removed' ? 'An owner cannot be removed.' : 'Workspace role changes cannot demote an owner.');
  }
  if (action.type === 'member.removed') {
    const drainedClaims = state.claims.filter(c => c.holder === member.id).map(c => c.id).sort();
    const reopenedHandoffs = state.handoffs.filter(h => h.state === 'accepted' && h.assignee === member.id).map(h => h.id).sort();
    return { memberId: member.id, drainedClaims, reopenedHandoffs };
  }
  if (!['admin', 'member'].includes(action.role)) throw new Error('role must be admin or member.');
  if (member.role === action.role) throw new Error('Member already has that role.');
  return { memberId: action.memberId, previousRole: member.role, role: action.role };
}

/**
 * The single mutation path: caller authority check, validation and the audited
 * append. Caller must hold the team lock; `actor` must already be a verified
 * local human (direct calls) or the human approver of an access request.
 */
function applyWorkspaceAction(team: string, actor: TeamActor, action: WorkspaceAction, provenance?: Record<string, unknown>): TeamEvent {
  const state = teamState(team);
  const caller = state.members.find(m => m.id === actor.id);
  if (!caller || caller.kind !== 'human' || !['owner', 'admin'].includes(caller.role)) {
    throw new Error('Workspace changes require a human owner/admin.');
  }
  const payload = { ...workspacePayload(state, actor, action), ...provenance };
  if (action.type === 'member.removed') {
    for (const claimId of payload['drainedClaims'] as string[]) {
      const released = releaseCoordinationBySource({ origin: 'team', sourceId: claimId });
      if (released.status === 'unavailable') throw new Error('Claim store unavailable.');
    }
  }
  return appendUnlocked(team, actor, action.type, payload);
}

export function updateWorkspace(team: string, actor: TeamActor, action: WorkspaceAction) {
  actor = assertLocalHuman(actor);
  return withTeamLock(team, () => applyWorkspaceAction(team, actor, action));
}

export function describeAccessAction(action: AccessRequestAction): string {
  switch (action.type) {
    case 'member.invited': return `invite ${action.memberId}`;
    case 'member.role-changed': return `set ${action.memberId} role to ${action.role}`;
    case 'repo.linked': return `link ${action.repo}`;
  }
}

const sameAction = (a: AccessRequestAction, b: AccessRequestAction): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Agent-facing half of workspace access: file a structured request that parks
 * as a pending approval a human owner/admin decides with `phm team
 * approve|deny`. Requests are validated against current state up front (a
 * request that can never apply is rejected instead of cluttering the queue)
 * and identical pending requests dedupe to the same approval.
 */
export function requestAccess(team: string, actor: TeamActor, request: unknown, note?: string) {
  const action = parseAccessRequestAction(request);
  if (!action) {
    throw new Error('request must be one of: {"type":"member.invited","memberId":"human:<name>"}, {"type":"member.role-changed","memberId":"human:<name>","role":"admin"|"member"}, {"type":"repo.linked","repo":"owner/name"}.');
  }
  return withTeamLock(team, () => {
    const state = teamState(team);
    workspacePayload(state, actor, action);
    const existing = state.approvals.find(a => a.state === 'pending' && a.access && sameAction(a.access, action));
    if (existing) return { approvalId: existing.id, state: 'pending' as const, deduped: true as const, note: `Already awaiting a human owner/admin: phm team approve ${existing.id} --team ${team}` };
    const ev = appendUnlocked(team, actor, 'access.requested', { request: action, ...(note?.trim() ? { note: note.trim().slice(0, 500) } : {}) });
    return { approvalId: ev.id, state: 'pending' as const, deduped: false as const, note: `access request (${describeAccessAction(action)}) needs a human owner/admin: phm team approve ${ev.id} --team ${team}` };
  });
}

export function decideApproval(team: string, actor: TeamActor, approvalId: string, decision: 'approve' | 'deny') {
  if (actor.kind !== 'human') throw new Error('Only humans can decide approvals.');
  actor = assertLocalHuman(actor);
  return withTeamLock(team, () => {
    if (decision === 'approve') {
      const before = teamState(team);
      const pending = before.approvals.find((x) => x.id === approvalId && x.state === 'pending');
      const caller = before.members.find(m => m.id === actor.id);
      if (pending?.access && caller?.kind === 'human' && ['owner', 'admin'].includes(caller.role)) {
        // An access request that went stale stays pending for a deny rather
        // than recording an approval whose mutation can no longer apply.
        workspacePayload(before, actor, pending.access);
      }
    }
    appendUnlocked(team, actor, 'approval.decided', { approvalId, decision });
    const a = teamState(team).approvals.find((x) => x.id === approvalId);
    if (!a || a.decidedBy !== actor.id) throw new Error('Approval not applied (unknown id, already decided, or you are not an owner/admin).');
    if (a.state === 'approved' && a.access) {
      const applied = applyWorkspaceAction(team, actor, a.access, { approvalId: a.id });
      return { approvalId, state: a.state, applied: { type: applied.type, eventId: applied.id } };
    }
    return { approvalId, state: a.state };
  });
}

/** Detached records, newest first; deliberately no update/delete API. */
export function readTeamAudit(team: string) {
  return readEvents(team).filter(e => ['member.joined', 'member.invited', 'member.removed', 'member.role-changed', 'repo.linked', 'access.requested'].includes(e.type)).reverse();
}
