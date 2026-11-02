/**
 * Invite / join by GitHub username. An invite grants team membership only: the
 * token names a team, a member and the log event that invited them, never a
 * credential. Each node keeps its own local auth; `joinWithInvite` derives the
 * joining identity from this node (identity.ts) and touches nothing else.
 */
import { localHumanActor, ownerConfigPath } from './identity.js';
import type { TeamActor } from './protocol.js';
import { appendUnlocked, readEvents, withTeamLock } from './store.js';
import { teamState } from './state.js';
import { updateWorkspace } from './workspace.js';

const INVITE_PREFIX = 'phm-invite-v1.';
const GH_USER_RE = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

export interface TeamInvite { team: string; member: string; event: string }

/** `octocat`, `@octocat` or `human:octocat` -> `human:octocat`. */
export function memberIdForGithubUser(input: string): string {
  const name = input.trim().replace(/^human:/, '').replace(/^@/, '');
  if (!GH_USER_RE.test(name)) throw new Error(`"${input}" is not a GitHub username (letters, digits, single hyphens, max 39). Example: phm team invite octocat`);
  return `human:${name.toLowerCase()}`;
}

export function encodeInvite(invite: TeamInvite): string {
  return INVITE_PREFIX + Buffer.from(JSON.stringify({ t: invite.team, m: invite.member, e: invite.event })).toString('base64url');
}

export function decodeInvite(token: string): TeamInvite {
  const fail = () => new Error('Not a valid invite. Ask an owner/admin to run `phm team invite <your-github-user>` and paste the phm-invite-v1.… line it prints.');
  if (!token.startsWith(INVITE_PREFIX)) throw fail();
  try {
    const o = JSON.parse(Buffer.from(token.slice(INVITE_PREFIX.length), 'base64url').toString('utf8')) as { t?: unknown; m?: unknown; e?: unknown };
    if (typeof o.t !== 'string' || typeof o.m !== 'string' || typeof o.e !== 'string') throw fail();
    return { team: o.t, member: o.m, event: o.e };
  } catch { throw fail(); }
}

export function inviteMember(team: string, actor: TeamActor, githubUser: string) {
  const memberId = memberIdForGithubUser(githubUser);
  const ev = updateWorkspace(team, actor, { type: 'member.invited', memberId });
  const invite = encodeInvite({ team, member: memberId, event: ev.id });
  return { team, member: memberId, role: 'member' as const, invite, grants: 'membership-only' as const, next: `On the invited person's own node: phm team join ${invite}` };
}

export function joinWithInvite(token: string, actor: TeamActor = localHumanActor()) {
  const inv = decodeInvite(token);
  if (actor.id !== inv.member) {
    throw new Error(`This invite is for ${inv.member} but this node's local identity is ${actor.id}. Run it from that person's account, or pin the name in ${ownerConfigPath()} as {"human":"${inv.member.slice(6)}"}.`);
  }
  return withTeamLock(inv.team, () => {
    const events = readEvents(inv.team);
    const invited = events.find(e => e.id === inv.event && e.type === 'member.invited' && e.payload['memberId'] === inv.member);
    if (!invited || !teamState(inv.team).members.some(m => m.id === inv.member)) {
      throw new Error(`No live invite for ${inv.member} in this node's log of team "${inv.team}" (never synced here, or revoked). Get the owner's latest log via your sync service, or ask an owner/admin to re-run: phm team invite ${inv.member.slice(6)} --team ${inv.team}`);
    }
    const already = events.some(e => e.type === 'member.joined' && e.actor.id === actor.id && e.id > invited.id);
    const ev = already ? undefined : appendUnlocked(inv.team, actor, 'member.joined', {});
    return { team: inv.team, member: actor.id, joined: true as const, alreadyJoined: already, event: ev?.id ?? null, authority: 'this-node-local-auth' as const };
  });
}
