import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addTeamPerson, DirectoryRefusedError, removeTeamPerson, teamDirectory } from '../src/core/teams/directory.js';
import { appendEvent, readEvents } from '../src/core/teams/store.js';
import { teamState } from '../src/core/teams/state.js';
import { cmdTeam } from '../src/cli/team.js';
import { routeMember, shareLeft, shareTotal, toMember, type TeamPerson } from '../src/shared/team-directory.js';

const team = 'seat-fixture';
const owner = { kind: 'human' as const, id: 'human:member-a' }, other = { kind: 'human' as const, id: 'human:member-c' };
let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'team-seats-')); vi.stubEnv('ASHLR_HOME', home); appendEvent(team, owner, 'member.joined', {}); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });
const addB = (extra: Record<string, unknown> = {}) => addTeamPerson(team, owner, { displayName: 'Member B', slack: 'UMEMBERB', verified: true, poolSharePct: 30, allowedRepos: ['Acme/App'], ...extra });

describe('team seats', () => {
  it('lets an owner add a member: a local record, a note to share, and nothing else', () => {
    const before = readEvents(team).length, r = addB();
    expect(r).toMatchObject({ schema: 'phantom.team.v1', version: 1 });
    expect(r.member).toEqual({ id: r.person.id, display_name: 'Member B', role: 'member', channels: { slack: ['UMEMBERB'] },
      pools: [], seats: [], pool_share_pct: 30, allowed_repos: ['acme/app'], created_at: expect.stringMatching(/^\d{4}-/) });
    expect(r.note).toContain('phm team join'); expect(r.next).toContain('Nothing was sent');
    // The only effect is one appended directory record by the owner; no membership, invite or message.
    const events = readEvents(team).slice(before);
    expect(events.map(e => [e.type, e.actor.id])).toEqual([['person.added', owner.id]]);
    expect(teamState(team).members.map(m => m.id)).toEqual([owner.id]);
    expect(teamState(team).messages).toEqual([]);
  });

  it('refuses a non-owner, an agent, and a team with no owner, without writing', () => {
    appendEvent(team, other, 'member.joined', {}); // second human joins as a plain member
    const before = readEvents(team).length;
    for (const actor of [other, { kind: 'human' as const, id: 'human:nobody' }, { kind: 'agent' as const, id: owner.id }]) {
      expect(() => addTeamPerson(team, actor, { displayName: 'Member D' })).toThrow(DirectoryRefusedError);
    }
    const added = addB();
    expect(() => removeTeamPerson(team, other, added.person.id)).toThrow(DirectoryRefusedError);
    expect(() => addTeamPerson('empty-fixture', owner, { displayName: 'Member D' })).toThrow(/no owner yet/);
    expect(readEvents(team).length).toBe(before + 1);
    expect(readEvents('empty-fixture')).toEqual([]);
  });

  it('routes a verified member message to them and keeps every other sender unverified', () => {
    const b = addB().person;
    addTeamPerson(team, owner, { displayName: 'Member D', slack: 'UMEMBERD' }); // ids not checked: pending
    const dir = teamDirectory(team);
    expect(routeMember({ channel: 'slack', sender: 'UMEMBERB' }, dir)).toMatchObject({ id: b.id, display_name: 'Member B' });
    expect(routeMember({ channel: 'slack', sender: ' umemberb ' }, dir)).toMatchObject({ id: b.id });
    for (const message of [{ channel: 'slack', sender: 'UMEMBERZ' }, { channel: 'slack', sender: 'UMEMBERD' }, { channel: 'email', sender: 'UMEMBERB' },
      { channel: 'slack', sender: '' }, { channel: 'slack', sender: undefined as unknown as string }]) expect(routeMember(message, dir)).toBe('unverified');
    // One sender id claimed by two people proves neither.
    const twin: TeamPerson = { ...b, id: 'person:twin', displayName: 'Twin' };
    expect(routeMember({ channel: 'slack', sender: 'UMEMBERB' }, { people: [...dir.people, twin] })).toBe('unverified');
    expect(routeMember({ channel: 'slack', sender: 'UMEMBERB' }, { people: [] })).toBe('unverified');
  });

  it('keeps pool shares at 100 or less in total', () => {
    addB({ poolSharePct: 60 });
    expect(() => addTeamPerson(team, owner, { displayName: 'Member D', poolSharePct: 41 })).toThrow(/100 or less/);
    expect(() => addTeamPerson(team, owner, { displayName: 'Member D', poolSharePct: 101 })).toThrow();
    addTeamPerson(team, owner, { displayName: 'Member D', poolSharePct: 40 });
    expect(shareTotal(teamDirectory(team).people)).toBe(100);
    expect(() => addTeamPerson(team, owner, { displayName: 'Member E', poolSharePct: 1 })).toThrow(/100 or less/);
  });

  it('reports the share left per pool and shows unknown usage as unknown', () => {
    const b = toMember(addB().person);
    expect(shareLeft(b, [
      { pool: 'pool-a', pctUsed: 20, usedByMember: { [b.id]: 12.5 } }, // own usage known
      { pool: 'pool-b', pctUsed: 90 },                                 // capped by what the pool has left
      { pool: 'pool-c', pctUsed: 10, status: 'red' },
      { pool: 'pool-d', pctUsed: null },
      { pool: 'pool-e', pctUsed: 0, usedByMember: { [b.id]: 45 } },
    ])).toEqual([
      { pool: 'pool-a', left_pct: 17.5, basis: 'member' }, { pool: 'pool-b', left_pct: 10, basis: 'pool' }, { pool: 'pool-c', left_pct: 0, basis: 'pool' },
      { pool: 'pool-d', left_pct: null, basis: 'unknown' }, { pool: 'pool-e', left_pct: 0, basis: 'member' },
    ]);
    expect(shareLeft(b, [])).toEqual([]);
  });

  it('refuses to remove the last owner and removes a teammate record', () => {
    const b = addB().person;
    expect(() => removeTeamPerson(team, owner, owner.id)).toThrow('The last owner cannot be removed');
    expect(() => removeTeamPerson(team, owner, 'person:missing')).toThrow(/not found/);
    expect(removeTeamPerson(team, owner, b.id)).toEqual({ schema: 'phantom.team.v1', version: 1, removed: b.id });
    expect(teamDirectory(team).people.map(p => p.id)).toEqual([owner.id]);
    expect(routeMember({ channel: 'slack', sender: 'UMEMBERB' }, teamDirectory(team))).toBe('unverified');
  });

  it('gives agents the same view: phm team list --json carries schema, version and member records', async () => {
    addB();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {}), error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await cmdTeam(['list', '--team', team, '--json'])).toBe(0);
      const listed = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
      expect(listed).toMatchObject({ schema: 'phantom.team.v1', version: 1, share_total_pct: 30 });
      expect(listed.members.map((m: { role: string; pool_share_pct: number }) => [m.role, m.pool_share_pct])).toEqual([['owner', 0], ['member', 30]]);
      expect(listed.members[0].created_at).toBeNull();
      // This test process is an agent or an unlisted OS user, so the CLI refuses to add or remove.
      for (const args of [['add', 'Member D'], ['remove', listed.members[1].id]]) {
        expect(await cmdTeam([...args, '--team', team, '--json'])).toBe(1);
        expect(JSON.parse(String(error.mock.calls.at(-1)?.[0]))).toMatchObject({ schema: 'phantom.team.v1', version: 1, refused: true });
      }
      expect(teamDirectory(team).people).toHaveLength(2);
    } finally { log.mockRestore(); error.mockRestore(); }
  });
});
