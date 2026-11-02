import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_ENV_MARKERS, ownerConfigPath } from '../src/core/teams/identity.js';
import {
  acquireClaim, appendEvent, decodeInvite, inviteMember, joinWithInvite, requestHandoff, teamDir, teamState, transitionHandoff, updateWorkspace,
  type TeamActor,
} from '../src/core/teams/index.js';
import { cmdTeam } from '../src/cli/team.js';

const T = 'join-test';
const owner: TeamActor = { kind: 'human', id: 'human:owner' };
const octo: TeamActor = { kind: 'human', id: 'human:octocat' };
let home: string;
const asHuman = (name: string) => writeFileSync(ownerConfigPath(), JSON.stringify({ human: name }));
const log = () => readFileSync(join(teamDir(T), 'events.jsonl'), 'utf8');

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'team-join-'));
  vi.stubEnv('ASHLR_HOME', home);
  for (const marker of AGENT_ENV_MARKERS) vi.stubEnv(marker, '');
  mkdirSync(dirname(ownerConfigPath()), { recursive: true });
  asHuman('owner');
  appendEvent(T, owner, 'member.joined', {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

describe('team invite / join / remove', () => {
  it('invite grants membership only and carries no credential', () => {
    const r = inviteMember(T, owner, '@OctoCat');
    expect(r).toMatchObject({ member: 'human:octocat', role: 'member', grants: 'membership-only' });
    expect(Object.keys(decodeInvite(r.invite)).sort()).toEqual(['event', 'member', 'team']);
    expect(log()).not.toContain(r.invite);
    expect(teamState(T).members.find(m => m.id === octo.id)?.role).toBe('member');
  });

  it('rejects non GitHub usernames with an example', () => {
    expect(() => inviteMember(T, owner, 'bad name!')).toThrow(/not a GitHub username.*phm team invite octocat/);
  });

  it('joins from the invited identity only, once', () => {
    const { invite } = inviteMember(T, owner, 'octocat');
    expect(() => joinWithInvite(invite, owner)).toThrow(/local identity is human:owner/);
    asHuman('octocat');
    expect(joinWithInvite(invite)).toMatchObject({ team: T, member: octo.id, joined: true, alreadyJoined: false, authority: 'this-node-local-auth' });
    const lines = log().split('\n').length;
    expect(joinWithInvite(invite)).toMatchObject({ alreadyJoined: true, event: null });
    expect(log().split('\n').length).toBe(lines);
  });

  it('refuses an invite this node never saw, with a fix', () => {
    const { invite } = inviteMember(T, owner, 'octocat');
    rmSync(teamDir(T), { recursive: true });
    appendEvent(T, owner, 'member.joined', {});
    asHuman('octocat');
    expect(() => joinWithInvite(invite)).toThrow(/No live invite.*phm team invite octocat --team join-test/);
    expect(() => joinWithInvite('garbage')).toThrow(/Not a valid invite/);
  });

  it('remove drains claims and handoffs, ignores later events, and can be re-invited', () => {
    inviteMember(T, owner, 'octocat');
    asHuman('octocat'); appendEvent(T, octo, 'member.joined', {});
    asHuman('owner');
    expect(acquireClaim(T, octo, { repo: 'a/b' }, 'work').ok).toBe(true);
    const h = requestHandoff(T, owner, { title: 'task' });
    transitionHandoff(T, octo, h.handoffId, 'accept');
    expect(teamState(T).claims).toHaveLength(1);

    const ev = updateWorkspace(T, owner, { type: 'member.removed', memberId: octo.id });
    expect(ev.payload).toMatchObject({ drainedClaims: [expect.any(String)], reopenedHandoffs: [h.handoffId] });
    let s = teamState(T);
    expect(s.members.some(m => m.id === octo.id)).toBe(false);
    expect(s.claims).toEqual([]);
    expect(s.handoffs[0]).toMatchObject({ state: 'open', assignee: null });

    appendEvent(T, octo, 'message.posted', { text: 'still here' });
    expect(teamState(T).members.some(m => m.id === octo.id)).toBe(false);
    expect(() => joinWithInvite(inviteMember(T, owner, 'octocat').invite, octo)).not.toThrow();
    s = teamState(T);
    expect(s.members.find(m => m.id === octo.id)?.role).toBe('member');
  });

  it('only owner/admin can remove, never an owner or self', () => {
    inviteMember(T, owner, 'octocat');
    expect(() => updateWorkspace(T, owner, { type: 'member.removed', memberId: owner.id })).toThrow(/yourself/);
    expect(() => updateWorkspace(T, owner, { type: 'member.removed', memberId: 'human:ghost' })).toThrow(/Unknown human member/);
    asHuman('octocat');
    expect(() => updateWorkspace(T, octo, { type: 'member.removed', memberId: owner.id })).toThrow(/owner\/admin/);
  });

  it('CLI: invite, join and remove with stable --json shapes', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdTeam(['invite', 'octocat', '--team', T, '--json'])).toBe(0);
    const inv = JSON.parse(String(out.mock.calls.at(-1)?.[0]));
    expect(Object.keys(inv)).toEqual(['team', 'member', 'role', 'invite', 'grants', 'next']);
    asHuman('octocat');
    expect(await cmdTeam(['join', inv.invite, '--json'])).toBe(0);
    expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toMatchObject({ joined: true, member: octo.id });
    asHuman('owner');
    expect(await cmdTeam(['remove', 'octocat', '--team', T, '--json'])).toBe(0);
    expect(JSON.parse(String(out.mock.calls.at(-1)?.[0])).payload).toEqual({ memberId: octo.id, drainedClaims: [], reopenedHandoffs: [] });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdTeam(['remove', 'octocat', '--team', T])).toBe(1);
    expect(String(err.mock.calls.at(-1)?.[0])).toMatch(/Unknown human member human:octocat.*phm team view/);
  });
});
