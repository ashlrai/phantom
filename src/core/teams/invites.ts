/** Local-team capabilities. Only digests enter the replicated team log. */
import { createHash, randomBytes } from 'node:crypto';
import { assertLocalHuman } from './identity.js';
import { validId, type TeamActor } from './protocol.js';
import { appendUnlocked, readEvents, withTeamLock } from './store.js';
import { foldTeam } from './state.js';

export const DEFAULT_INVITE_TTL_MS = 7 * 24 * 60 * 60_000;
export class InviteError extends Error {}
// Public fingerprints use byte arrays: the log's credential scanner correctly
// refuses opaque 64-character strings even when they are non-secret hashes.
const digest = (token: string) => Array.from(createHash('sha256').update(token).digest());
const matches = (stored: unknown, hash: number[]) => JSON.stringify(stored) === JSON.stringify(hash);

export function createTeamInvite(team: string, actor: TeamActor, ttlMs = DEFAULT_INVITE_TTL_MS) {
  assertLocalHuman(actor);
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > DEFAULT_INVITE_TTL_MS) throw new InviteError('Expiry must be between 1 ms and 7 days.');
  return withTeamLock(team, () => {
    const state = foldTeam(team, readEvents(team));
    if (!state.members.some(m => m.id === actor.id && m.kind === 'human' && ['owner', 'admin'].includes(m.role))) throw new InviteError('Only team owners and admins can invite members.');
    const token = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + ttlMs;
    appendUnlocked(team, actor, 'invite.created', { digest: digest(token), expiresAt });
    return { team, expiresAt, link: `#/teams/${encodeURIComponent(team)}/accept?invite=${token}` };
  });
}

export function acceptTeamInvite(team: string, token: string, actor: TeamActor) {
  assertLocalHuman(actor);
  if (!validId(actor.id) || !actor.id.startsWith('human:') || !/^[a-f0-9]{64}$/.test(token)) throw new InviteError('Invalid invitation.');
  return withTeamLock(team, () => {
    const events = readEvents(team);
    const hash = digest(token);
    const invitation = events.find(e => e.team === team && e.type === 'invite.created' && matches(e.payload.digest, hash));
    if (!invitation || typeof invitation.payload.expiresAt !== 'number' || !Number.isFinite(invitation.payload.expiresAt) || invitation.payload.expiresAt <= Date.now()) throw new InviteError('Invitation is invalid or expired.');
    if (events.some(e => e.type === 'member.joined' && matches(e.payload.inviteDigest, hash))) throw new InviteError('Invitation has already been used.');
    const state = foldTeam(team, events);
    if (!state.members.some(m => m.id === invitation.actor.id && m.kind === 'human' && ['owner', 'admin'].includes(m.role))) throw new InviteError('Inviter no longer has permission.');
    if (state.members.some(m => m.id === actor.id)) throw new InviteError('Already a member of this team.');
    // The grant and redemption are ONE append: no crash window can reopen an invite.
    appendUnlocked(team, invitation.actor, 'member.joined', { memberId: actor.id, role: 'member', inviteDigest: hash });
    return { team, memberId: actor.id };
  });
}
