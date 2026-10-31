/**
 * `phm team` — the human side of the team protocol (docs/architecture/teams.md).
 * Agents use the phm_team_* MCP tools; humans join, view, approve and claim here.
 */
import { userInfo } from 'node:os';
import {
  localHumanActor, DEFAULT_TEAM, acquireClaim, appendEvent, decideApproval, releaseClaim, teamState, updateWorkspace, type TeamActor,
} from '../core/teams/index.js';

const USAGE = `Usage: phm team <view|join|invite|role|link|approve|deny|claim|release|say> [--team <id>] [--as <name>] [--json]
  view                         Members, presence, claims, handoffs and pending approvals
  join [--role admin]          Join as the local human (first human becomes owner; --as is ignored)
  invite <human:name>          Add a local workspace member (no external message)
  role <human:name> <admin|member>  Change a member role (owner/admin only)
  link <owner/repo>            Link a repository (owner/admin only)
  approve|deny <approvalId>    Decide a consequential handoff (owner/admin only; identity is the local OS user/owner.json, never --as)
  claim <owner/repo> [--branch b] [--path p] [--reason r] [--ttl-min n]
  release <claimId>
  say <text...>                Post a message to the team channel`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

export async function cmdTeam(argv: string[]): Promise<number> {
  const args = [...argv];
  const json = args.includes('--json'); if (json) args.splice(args.indexOf('--json'), 1);
  const team = flag(args, '--team') ?? DEFAULT_TEAM;
  const name = (flag(args, '--as') ?? process.env['PHM_TEAM_USER'] ?? userInfo().username).toLowerCase().replace(/[^a-z0-9._-]/g, '');
  const me: TeamActor = { kind: 'human', id: `human:${name || 'me'}` };
  const [sub = 'view', ...rest] = args;
  const out = (v: unknown, text: string) => { console.log(json ? JSON.stringify(v, null, 2) : text); return 0; };
  try {
    switch (sub) {
      case 'view': {
        const s = teamState(team);
        if (json) return out(s, '');
        const lines = [`Team ${team} — ${s.members.length} members, ${s.claims.length} claims, ${s.handoffs.filter((h) => h.state !== 'completed' && h.state !== 'declined').length} open handoffs`];
        for (const m of s.members) lines.push(`  ${m.online ? '●' : '○'} ${m.id} (${m.role}${m.provider ? `, ${m.provider}` : ''})${m.status ? ` — ${m.status}` : ''}`);
        for (const repo of s.repos) lines.push(`  repo: ${repo}`);
        for (const c of s.claims) lines.push(`  ⚑ ${c.target.repo}${c.target.branch ? `@${c.target.branch}` : ''}${c.target.path ? `:${c.target.path}` : ''} by ${c.holder} until ${c.expiresAt} [${c.id}]`);
        for (const h of s.handoffs.filter((x) => x.state !== 'completed' && x.state !== 'declined')) lines.push(`  → ${h.title} (${h.state}) ${h.from} → ${h.assignee ?? h.to ?? 'anyone'} [${h.id}]`);
        const pending = s.approvals.filter((a) => a.state === 'pending');
        for (const a of pending) lines.push(`  ! approval needed: ${a.action} requested by ${a.requestedBy} — phm team approve ${a.id}`);
        return out(s, lines.join('\n'));
      }
      case 'invite': case 'role': case 'link': {
        if (rest.length !== (sub === 'role' ? 2 : 1)) throw new Error(USAGE);
        if (sub === 'role' && rest[1] !== 'admin' && rest[1] !== 'member') throw new Error('role must be admin or member.');
        const action = sub === 'link' ? { type: 'repo.linked' as const, repo: rest[0]! }
          : sub === 'invite' ? { type: 'member.invited' as const, memberId: rest[0]! }
          : { type: 'member.role-changed' as const, memberId: rest[0]!, role: rest[1] as 'admin' | 'member' };
        const ev = updateWorkspace(team, localHumanActor(), action);
        return out(ev, `${ev.type} [${ev.id}]`);
      }
      case 'join': { const actor = localHumanActor(); const role = flag(rest, '--role'); const ev = appendEvent(team, actor, 'member.joined', role ? { role } : {}); return out(ev, `Joined ${team} as ${actor.id}.`); }
      case 'approve': case 'deny': { const r = decideApproval(team, localHumanActor(), rest[0] ?? '', sub === 'approve' ? 'approve' : 'deny'); return out(r, `${r.approvalId}: ${r.state}`); }
      case 'claim': {
        const branch = flag(rest, '--branch'); const path = flag(rest, '--path'); const reason = flag(rest, '--reason') ?? ''; const ttl = flag(rest, '--ttl-min');
        const r = acquireClaim(team, me, { repo: rest[0] ?? '', branch, path }, reason, ttl ? Number(ttl) * 60_000 : undefined);
        if (!r.ok) { out(r, `Conflict: held by ${r.conflicts.map((c) => c.holder).join(', ')}`); return 1; }
        return out(r, `Claimed [${r.claimId}] until ${r.expiresAt}`);
      }
      case 'release': return out(releaseClaim(team, me, rest[0] ?? ''), 'Released.');
      case 'say': { if (!rest.length) throw new Error('say needs text'); const ev = appendEvent(team, me, 'message.posted', { channel: 'general', text: rest.join(' ') }); return out(ev, 'Posted.'); }
      default: console.error(USAGE); return 2;
    }
  } catch (err) {
    console.error(`phm team: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
