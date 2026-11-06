/** Workspace mutations and their audit records are the same locked append. */
import { assertLocalHuman } from './identity.js';
import { validId, type TeamActor } from './protocol.js';
import { appendUnlocked, readEvents, withTeamLock } from './store.js';
import { teamState } from './state.js';

export type WorkspaceAction =
  | { type: 'member.invited'; memberId: string }
  | { type: 'member.removed'; memberId: string }
  | { type: 'member.role-changed'; memberId: string; role: 'admin' | 'member' }
  | { type: 'repo.linked'; repo: string };

export function updateWorkspace(team: string, actor: TeamActor, action: WorkspaceAction) {
  actor = assertLocalHuman(actor);
  return withTeamLock(team, () => {
    const state = teamState(team);
    const caller = state.members.find(m => m.id === actor.id);
    if (!caller || caller.kind !== 'human' || !['owner', 'admin'].includes(caller.role)) {
      throw new Error('Workspace changes require a human owner/admin.');
    }
    if (action.type === 'repo.linked') {
      if (!/^[\w.-]+\/[\w.-]+$/.test(action.repo)) throw new Error('repo must be owner/name.');
      const repo = action.repo.toLowerCase();
      if (state.repos.includes(repo)) throw new Error('Repository already linked.');
      return appendUnlocked(team, actor, action.type, { repo });
    }
    if (action.type !== 'member.invited' && action.type !== 'member.role-changed' && action.type !== 'member.removed') throw new Error('Unknown workspace action.');
    if (!validId(action.memberId) || !/^human:[a-z0-9][a-z0-9._-]*$/i.test(action.memberId)) throw new Error('memberId must be human:<name>.');
    const member = state.members.find(m => m.id === action.memberId);
    if (action.type === 'member.invited') {
      if (member) throw new Error('Member already exists.');
      return appendUnlocked(team, actor, action.type, { memberId: action.memberId, role: 'member' });
    }
    if (!member || member.kind !== 'human') throw new Error(`Unknown human member ${action.memberId}. Run: phm team view --team ${team} --json`);
    if (action.type === 'member.removed') {
      if (member.id === actor.id) throw new Error('You cannot remove yourself; ask another owner/admin.');
      if (member.role === 'owner') throw new Error('An owner cannot be removed.');
      const drainedClaims = state.claims.filter(c => c.holder === member.id).map(c => c.id).sort();
      const reopenedHandoffs = state.handoffs.filter(h => h.state === 'accepted' && h.assignee === member.id).map(h => h.id).sort();
      return appendUnlocked(team, actor, action.type, { memberId: member.id, drainedClaims, reopenedHandoffs });
    }
    if (member.id === actor.id) throw new Error('Use another owner/admin to change your role.');
    if (member.role === 'owner') throw new Error('Workspace role changes cannot demote an owner.');
    if (!['admin', 'member'].includes(action.role)) throw new Error('role must be admin or member.');
    if (member.role === action.role) throw new Error('Member already has that role.');
    return appendUnlocked(team, actor, action.type, { memberId: action.memberId, previousRole: member.role, role: action.role });
  });
}

/** Detached records, newest first; deliberately no update/delete API. */
export function readTeamAudit(team: string) {
  return readEvents(team).filter(e => ['member.joined', 'member.invited', 'member.removed', 'member.role-changed', 'repo.linked'].includes(e.type)).reverse();
}
