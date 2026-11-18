import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addTeamPerson, foldDirectory, removeTeamPerson, teamDirectory } from '../src/core/teams/directory.js';
import { appendEvent, readEvents, teamDir } from '../src/core/teams/store.js';
import { teamState } from '../src/core/teams/state.js';
import type { TeamEvent } from '../src/core/teams/protocol.js';
import type { Org } from '../src/core/org/org.js';
import { cmdTeam } from '../src/cli/team.js';
import { AGENT_ENV_MARKERS, ownerConfigPath } from '../src/core/teams/identity.js';

const team = 'directory-fixture';
const person = { id: 'person:founder', displayName: 'Avery', role: 'founder', identities: [{ kind: 'email', value: 'avery@example.test', state: 'verified' }], lanes: ['claude'], seats: ['avery-agent'], status: 'member' };
const event = (p: unknown, scope = team): TeamEvent => ({ v: 1, id: 'fixture-1', ts: '2026-11-17T00:00:00Z', team: scope, actor: { kind: 'agent', id: 'agent:directory' }, type: 'person.added', payload: { person: p } });
let home: string;
// Adding is owner-only, so each fixture team starts with one joined owner.
const owner = { kind: 'human' as const, id: 'human:owner' };
const join1 = () => appendEvent(team, owner, 'member.joined', {});
const ownerRow = { id: 'human:owner', displayName: 'owner', role: 'founder', identities: [], lanes: [], seats: [], status: 'member' };
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'team-directory-')); vi.stubEnv('ASHLR_HOME', home); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

describe('team directory', () => {
  it('round trips CLI add, list, show and remove with versioned JSON', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {}), error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const marker of AGENT_ENV_MARKERS) vi.stubEnv(marker, '');
      mkdirSync(dirname(ownerConfigPath()), { recursive: true }); writeFileSync(ownerConfigPath(), JSON.stringify({ human: 'owner' })); join1();
      const run = (args: string[]) => cmdTeam([...args, '--team', team, '--json']);
      expect(await run(['add', 'River', '--email', 'river@example.test'])).toBe(0);
      const added = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
      for (const args of [['list'], ['show', added.person.id]]) { expect(await run(args)).toBe(0); expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ schema: 'phantom.team.v1', version: 1 }); }
      expect(await run(['remove', added.person.id])).toBe(0);
      expect(await run(['add', 'River', '--email'])).toBe(1); expect(error).toHaveBeenCalled();
      expect(teamDirectory(team).people).toEqual([ownerRow]);
    } finally { log.mockRestore(); error.mockRestore(); }
  });
  it('returns the versioned empty team without creating membership', () => {
    expect(teamDirectory(team)).toEqual({ schema: 'phantom.team.v1', version: 1, team, people: [], orgState: 'absent' });
    expect(teamState(team).members).toEqual([]);
  });

  it('preserves a verified founder from trusted stored evidence', () => {
    expect(foldDirectory(team, [event(person)], null).people).toEqual([person]);
  });

  it('adds a pending draft, keeps identities pending, and grants no membership', () => {
    join1();
    const result = addTeamPerson(team, owner, { displayName: 'River', role: 'engineer', email: `${'r'.repeat(60)}@${'e'.repeat(50)}.test`, slack: 'U0EXAMPLE', phone: '+12025550123', lanes: ['claude'], seats: ['river-agent'] });
    expect(result).toMatchObject({ version: 1, person: { displayName: 'River', role: 'engineer', status: 'pending', lanes: ['claude'], seats: ['river-agent'] }, next: expect.any(String) });
    expect(result.person.identities.map(identity => identity.state)).toEqual(['pending', 'pending', 'pending']);
    expect(result.next.length).toBeGreaterThan(0);
    expect(teamDirectory(team).people).toEqual([ownerRow, result.person]);
    expect(teamState(team).members.map(member => member.id)).toEqual(['human:owner']);
    expect(readEvents(team).map(row => row.type)).toEqual(['member.joined', 'person.added']);
  });

  it('keeps unrecognized identity evidence unknown, never verified', () => {
    const unknown = { ...person, identities: [{ kind: 'email', value: 'avery@example.test', state: 'unrecognized' }] };
    expect(foldDirectory(team, [event(unknown)], null).people[0]?.identities[0]?.state).toBe('unknown');
  });

  it('projects existing org contributions and seats without claiming identity verification', () => {
    const org: Org = { version: 1, leader: 'avery', members: [{ id: 'avery', name: 'Avery', role: 'cofounder', machines: [{ id: 'avery-mac' }], contributions: [{ lane: 'claude', share: 25 }], agents: [{ id: 'avery-agent', lane: 'claude', machine: 'avery-mac', roles: ['implementer'] }] }] };
    const result = foldDirectory('default', [], org);
    expect(result.orgState).toBe('available');
    expect(result.people).toEqual([{ id: 'human:avery', displayName: 'Avery', role: 'founder', identities: [], lanes: ['claude'], seats: ['avery-agent'], status: 'member' }]);
    expect(foldDirectory(team, [], org).people).toEqual([]);
    expect(org.members[0]?.contributions[0]?.share).toBe(25);
  });

  it('ignores another team’s draft events and preserves existing human members', () => {
    expect(foldDirectory(team, [event(person, 'another-team')], null).people).toEqual([]);
    join1();
    addTeamPerson(team, owner, { displayName: 'River', role: 'viewer' });
    expect(teamState(team).members.map(member => member.id)).toEqual(['human:owner']);
    expect(teamDirectory('another-team').people).toEqual([]);
  });

  it.each(['token', 'secret', 'credentials'])('rejects a %s field even with harmless placeholder text, without writing it', key => {
    const placeholder = 'not-a-real-credential';
    join1();
    const draft = addTeamPerson(team, owner, { displayName: 'River', role: 'viewer' });
    const before = readFileSync(join(teamDir(team), 'events.jsonl'), 'utf8');
    expect(() => addTeamPerson(team, owner, { displayName: 'Casey', role: 'viewer', [key]: placeholder })).toThrow();
    expect(readFileSync(join(teamDir(team), 'events.jsonl'), 'utf8')).toBe(before);
    expect(JSON.stringify({ draft, directory: teamDirectory(team) })).not.toContain(placeholder);
    expect(before).not.toContain(placeholder);
  });

  it('removes a pending draft without removing authoritative membership', () => {
    join1();
    const draft = addTeamPerson(team, owner, { displayName: 'River', role: 'viewer' });
    expect(removeTeamPerson(team, owner, draft.person.id)).toEqual({ schema: 'phantom.team.v1', version: 1, removed: draft.person.id });
    expect(teamDirectory(team).people.some(row => row.id === draft.person.id)).toBe(false);
    expect(() => removeTeamPerson(team, owner, 'human:owner')).toThrow('The last owner cannot be removed');
    expect(teamState(team).members.map(member => member.id)).toEqual(['human:owner']);
  });
});
