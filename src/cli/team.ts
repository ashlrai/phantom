/**
 * `phm team` — the human side of the team protocol (docs/architecture/teams.md).
 * Agents use the phm_team_* MCP tools; humans join, view, approve and claim here.
 */
import { userInfo } from 'node:os';
import { addTeamPerson, DirectoryInputError, DirectoryRefusedError, OWNER_ONLY, removeTeamPerson, teamDirectory } from '../core/teams/directory.js';
import { memberRunningJobs } from '../core/teams/running-jobs.js';
import { shareTotal, TEAM_SCHEMA, toMember } from '../shared/team-directory.js';
import {
  inviteMember, joinWithInvite, localHumanActor, memberIdForGithubUser, DEFAULT_TEAM, acquireClaim, appendEvent, decideApproval, describeAccessAction, releaseClaim, teamState, updateWorkspace, type TeamActor,
} from '../core/teams/index.js';

const USAGE = `Usage: phm team <list|add|show|view|join|invite|remove|role|link|approve|deny|claim|release|say> [--team <id>] [--as <name>] [--json]
  (no verb) | list | show <id> People, the pools they bring, pool shares, agent seats and running jobs
  add <display-name> [--pools a,b] [--dry-run|--apply] [--share percent] [--repos owner/name,...] [--slack id] [--email address] [--phone +number] [--verified]
      [--role founder|engineer|viewer] [--lanes a,b] [--seats a,b]
                               Owner only. Saves a local record and prints a note to share yourself; nothing is sent.
                               --dry-run checks everything and saves nothing; --apply saves (the default).
                               Pools are lane names (phm lanes). Their other computer joins with phm node join (docs/NODES.md).
                               --verified: you checked the sender ids yourself, so their messages route to this teammate
  remove <id>                  Owner only. Remove a teammate by the id shown in list; the last owner cannot be removed
  view                         Members, presence, claims, handoffs and pending approvals
  join [--role admin]          Join as the local human (first human becomes owner; --as is ignored)
  join <invite>                Accept an invite on your own node (team comes from the invite; uses only this node's local auth)
  invite <gh-user>             Invite a GitHub user (owner/admin); prints an invite that grants membership only, never credentials
  remove <gh-user>             Revoke membership (owner/admin); drains that member's claims and reopens their accepted handoffs
  role <human:name> <admin|member>  Change a member role (owner/admin only)
  link <owner/repo>            Link a repository (owner/admin only)
  approve|deny <approvalId>    Decide a consequential handoff or an agent access request (owner/admin only; identity is the local OS user/owner.json, never --as)
  claim <owner/repo> [--branch b] [--path p] [--reason r] [--ttl-min n]
  release <claimId>
  say <text...>                Post a message to the team channel

With --json every verb answers success on stdout; a failure prints
{"schema":"phantom.team.v1","version":1,"error","refused"} on stderr.

Start: view --team <id>; confirm the authoritative local log and your task with the owner.
Team names do not sync machines. Roles do not grant repository or connector access.
Missing access/context: ask the owner/admin with a task reference and redacted error.
Returning: review handoff details with view --json, source links and claims before editing.
Guide: docs/TEAM.md`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

export async function cmdTeam(argv: string[]): Promise<number> {
  const args = [...argv];
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') { console.log(USAGE); return 0; }
  const json = args.includes('--json'); if (json) args.splice(args.indexOf('--json'), 1);
  const team = flag(args, '--team') ?? DEFAULT_TEAM;
  const name = (flag(args, '--as') ?? process.env['PHM_TEAM_USER'] ?? userInfo().username).toLowerCase().replace(/[^a-z0-9._-]/g, '');
  const me: TeamActor = { kind: 'human', id: `human:${name || 'me'}` };
  const [sub = 'list', ...rest] = args;
  const out = (v: unknown, text: string) => { console.log(json ? JSON.stringify(v, null, 2) : text); return 0; };
  // The owner is the local OS user; an agent process or a flag can never stand in.
  const owner = () => { try { return localHumanActor(); } catch { throw new DirectoryRefusedError(OWNER_ONLY); } };
  try {
    switch (sub) {
      case 'list': case 'show': {
        if (rest.length !== (sub === 'show' ? 1 : 0)) throw new DirectoryInputError('Use phm team list or phm team show <id>.');
        const directory = teamDirectory(team);
        const people = sub === 'show' ? directory.people.filter(p => p.id === rest[0]) : directory.people;
        if (sub === 'show' && !people.length) throw new DirectoryInputError('Teammate not found. Use phm team list.');
        const jobs = await memberRunningJobs(people);
        const jobWords = (id: string) => jobs[id]!.running === null ? 'unknown' : jobs[id]!.running === 0 ? 'none' : `${jobs[id]!.running} (${jobs[id]!.jobs.join(', ')})`;
        return out(sub === 'show' ? { schema: TEAM_SCHEMA, version: 1, team, orgState: directory.orgState, person: people[0], member: { ...toMember(people[0]!), running_jobs: jobs[people[0]!.id] } }
          : { ...directory, members: people.map(p => ({ ...toMember(p), running_jobs: jobs[p.id] })), share_total_pct: shareTotal(people) },
          [directory.orgState === 'unknown' ? 'Org data unavailable; showing team log.' : `Team ${team}: pool shares given out ${shareTotal(directory.people)}% of 100`, ...people.map(p =>
            `${p.displayName} (${toMember(p).role}, ${p.role}, ${p.status}) [${p.id}]\n  Sender ids: ${p.identities.map(i => `${i.kind} ${i.value}: ${i.state}`).join(', ') || 'unknown'}\n  Pool share: ${p.poolSharePct === undefined ? 'not set' : `${p.poolSharePct}%`}; repos: ${p.allowedRepos?.join(', ') || 'none listed'}\n  Pools: ${p.lanes.join(', ') || 'none'}; seats: ${p.seats.join(', ') || 'none'}; running jobs: ${jobWords(p.id)}`),
          ...(people.length ? [] : ['No teammates yet. Use phm team add <display-name> --pools claude --dry-run.', 'Jobs are counted by pool, not by person. Another computer joins with phm node join (docs/NODES.md).'])].join('\n'));
      }
      case 'add': {
        const verified = rest.includes('--verified'); if (verified) rest.splice(rest.indexOf('--verified'), 1);
        const dryRun = rest.includes('--dry-run'), apply = rest.includes('--apply');
        if (dryRun && apply) throw new DirectoryInputError('Choose --dry-run or --apply, not both.');
        for (const f of ['--dry-run', '--apply']) if (rest.includes(f)) rest.splice(rest.indexOf(f), 1);
        if (argv.some((v, i) => v.startsWith('--') && !['--json', '--verified', '--dry-run', '--apply'].includes(v) && (!argv[i + 1] || argv[i + 1]!.startsWith('--')))) throw new DirectoryInputError('Every teammate flag needs a value.');
        const share = flag(rest, '--share'), repos = flag(rest, '--repos');
        const role = flag(rest, '--role'), email = flag(rest, '--email'), slack = flag(rest, '--slack'), phone = flag(rest, '--phone');
        const lanes = [flag(rest, '--pools'), flag(rest, '--lanes')].filter(Boolean).join(','), seats = flag(rest, '--seats');
        if (rest.length !== 1 || rest[0]!.startsWith('-')) throw new DirectoryInputError('Use phm team add <display-name> with optional role, identities, lanes and seats.');
        const r = addTeamPerson(team, owner(), { displayName: rest[0], role, email, slack, phone, lanes: lanes ? lanes.split(',') : [], seats: seats?.split(','),
          ...(share !== undefined ? { poolSharePct: Number(share) } : {}), ...(repos ? { allowedRepos: repos.split(',') } : {}), ...(verified ? { verified } : {}) }, { dryRun });
        return out(r, `${dryRun ? 'Dry run, nothing saved. Would add' : 'Added'} ${r.person.displayName}${dryRun ? '' : ` [${r.person.id}]`}.\n${r.next}\n\n  ${r.note}`);
      }
      case 'view': {
        const s = teamState(team);
        if (json) return out(s, '');
        const lines = [`Team ${team} — ${s.members.length} members, ${s.claims.length} claims, ${s.handoffs.filter((h) => h.state !== 'completed' && h.state !== 'declined').length} open handoffs`];
        // Role labels state approval responsibility, so a member can see who may decide a handoff.
        const roleLabels: Record<string, string> = {
          owner: 'human owner; approves consequential actions', admin: 'human admin; approves consequential actions',
          member: 'human member; cannot approve consequential actions', agent: 'agent; cannot approve consequential actions',
        };
        for (const m of s.members) lines.push(`  ${m.online ? '●' : '○'} ${m.id} (${roleLabels[m.role] ?? m.role}${m.provider ? `, ${m.provider}` : ''})${m.status ? ` — ${m.status}` : ''}`);
        lines.push('  Presence: ● seen within 5 minutes; ○ inactive (membership is retained).');
        for (const repo of s.repos) lines.push(`  repo: ${repo}`);
        for (const c of s.claims) lines.push(`  ⚑ ${c.target.repo}${c.target.branch ? `@${c.target.branch}` : ''}${c.target.path ? `:${c.target.path}` : ''} by ${c.holder} until ${c.expiresAt} [${c.id}]`);
        for (const h of s.handoffs.filter((x) => x.state !== 'completed' && x.state !== 'declined')) lines.push(`  → ${h.title} (${h.state}) ${h.from} → ${h.assignee ?? h.to ?? 'anyone'} [${h.id}]`);
        const pending = s.approvals.filter((a) => a.state === 'pending');
        for (const a of pending) lines.push(`  ! approval needed: ${a.access ? `access request (${describeAccessAction(a.access)})` : a.action} requested by ${a.requestedBy}${a.note ? ` — "${a.note}"` : ''} — human owner/admin: phm team approve ${a.id} --team ${team}`);
        for (const m of s.messages.slice(-5)) lines.push(`  # ${m.channel} ${m.from} (${m.ts}): ${m.text}`);
        lines.push('Local log only: matching team names on other machines do not sync state.');
        lines.push('Shared context: phm_team_context_add / phm_team_context_get (MCP), with an explicit owner scope (personal, company, or client:<name>). This overview does not print context entries.');
        lines.push(s.members.length === 0
          ? `Next: confirm this is the intended local log with the team owner, then join from a human terminal: phm team join --team ${team}`
          : `Next: confirm your role and task with the owner; review handoff details and context refs: phm team view --team ${team} --json`);
        lines.push('Before editing: re-read task sources and resolve claims. Missing access/context: ask the owner/admin with the task reference and redacted error; retry the blocked check.');
        return out(s, lines.join('\n'));
      }
      case 'invite': case 'role': case 'link': case 'remove': {
        if (rest.length !== (sub === 'role' ? 2 : 1)) throw new Error(USAGE);
        if (sub === 'invite' && !rest[0]!.startsWith('human:')) {
          const r = inviteMember(team, localHumanActor(), rest[0]!);
          return out(r, `Invited ${r.member} to ${team} (membership only; no credentials in the invite).\n${r.invite}\n${r.next}`);
        }
        if (sub === 'remove') {
          if (/^(person|human):/.test(rest[0]!)) { const r = removeTeamPerson(team, owner(), rest[0]!); return out(r, 'Teammate removed.'); }
          const ev = updateWorkspace(team, localHumanActor(), { type: 'member.removed', memberId: memberIdForGithubUser(rest[0]!) });
          const p = ev.payload as { drainedClaims: string[]; reopenedHandoffs: string[] };
          return out(ev, `Removed ${rest[0]} from ${team}: drained ${p.drainedClaims.length} claims, reopened ${p.reopenedHandoffs.length} handoffs. Re-invite with: phm team invite ${rest[0]} --team ${team}`);
        }
        if (sub === 'role' && rest[1] !== 'admin' && rest[1] !== 'member') throw new Error('role must be admin or member.');
        const action = sub === 'link' ? { type: 'repo.linked' as const, repo: rest[0]! }
          : sub === 'invite' ? { type: 'member.invited' as const, memberId: rest[0]! }
          : { type: 'member.role-changed' as const, memberId: rest[0]!, role: rest[1] as 'admin' | 'member' };
        const ev = updateWorkspace(team, localHumanActor(), action);
        return out(ev, `${ev.type} [${ev.id}]`);
      }
      case 'join': if (rest[0] && !rest[0].startsWith('-')) {
        const r = joinWithInvite(rest[0]);
        return out(r, `${r.alreadyJoined ? 'Already joined' : 'Joined'} ${r.team} as ${r.member}. Your own local auth is used; nothing was shared.\nNext: phm team view --team ${r.team}`);
      } else { const actor = localHumanActor(); const role = flag(rest, '--role'); const ev = appendEvent(team, actor, 'member.joined', role ? { role } : {}); return out(ev, `Joined ${team} as ${actor.id}.\nNext: phm team view --team ${team}`); }
      case 'approve': case 'deny': { const r = decideApproval(team, localHumanActor(), rest[0] ?? '', sub === 'approve' ? 'approve' : 'deny'); return out(r, `${r.approvalId}: ${r.state}${'applied' in r && r.applied ? ` — applied ${r.applied.type} [${r.applied.eventId}]` : ''}`); }
      case 'claim': {
        const branch = flag(rest, '--branch'); const path = flag(rest, '--path'); const reason = flag(rest, '--reason') ?? ''; const ttl = flag(rest, '--ttl-min');
        const r = acquireClaim(team, me, { repo: rest[0] ?? '', branch, path }, reason, ttl ? Number(ttl) * 60_000 : undefined);
        if (!r.ok) { out(r, `Conflict: held by ${r.conflicts.map((c) => c.holder).join(', ')}`); return 1; }
        return out(r, `Claimed [${r.claimId}] until ${r.expiresAt}`);
      }
      case 'release': return out(releaseClaim(team, me, rest[0] ?? ''), 'Released.');
      case 'say': { if (!rest.length) throw new Error('say needs text'); const ev = appendEvent(team, me, 'message.posted', { channel: 'general', text: rest.join(' ') }); return out(ev, 'Posted.'); }
      default:
        if (json) console.error(JSON.stringify({ schema: TEAM_SCHEMA, version: 1, error: `Unknown team command '${sub}'. Run: phm team --help`, refused: false }));
        else console.error(USAGE);
        return 2;
    }
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const directoryVerb = ['list', 'show', 'add'].includes(sub) || (sub === 'remove' && /^(person|human):/.test(rest[0] ?? ''));
    // Arg-count checks throw the usage text itself; those are usage errors (exit 2).
    const usage = raw === USAGE;
    const error = usage ? 'Invalid arguments. Run: phm team --help'
      : directoryVerb ? (err instanceof DirectoryInputError || (sub === 'remove' && err instanceof Error) ? raw : 'Team directory unavailable.')
      : raw;
    if (json) console.error(JSON.stringify({ schema: TEAM_SCHEMA, version: 1, error, refused: err instanceof DirectoryRefusedError }));
    else console.error(usage || !directoryVerb ? `phm team: ${raw}` : `phm team: ${error}`);
    return usage ? 2 : 1;
  }
}
