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

describe('phm team add --dry-run, pools and running jobs', () => {
  const asOwner = () => { for (const marker of AGENT_ENV_MARKERS) vi.stubEnv(marker, ''); mkdirSync(dirname(ownerConfigPath()), { recursive: true }); writeFileSync(ownerConfigPath(), JSON.stringify({ human: 'owner' })); join1(); };
  const run = async (args: string[]) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {}), error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try { const code = await cmdTeam([...args, '--team', team, '--json']); return { code, out: String(log.mock.calls.at(-1)?.[0] ?? ''), err: String(error.mock.calls.at(-1)?.[0] ?? '') }; }
    finally { log.mockRestore(); error.mockRestore(); }
  };
  it('--dry-run writes nothing and --apply saves one member with pools and seat', async () => {
    asOwner();
    const dry = await run(['add', 'Sam', '--pools', 'claude,devin', '--seats', 'sam-agent', '--dry-run']);
    expect(dry.code).toBe(0); expect(JSON.parse(dry.out)).toMatchObject({ schema: 'phantom.team.v1', dry_run: true, written: false, member: { pools: ['claude', 'devin'], seats: ['sam-agent'] } });
    expect(teamDirectory(team).people.map(p => p.displayName)).toEqual(['owner']);
    expect((await run(['add', 'Sam', '--pools', 'claude', '--dry-run', '--apply'])).code).toBe(1);
    const saved = await run(['add', 'Sam', '--pools', 'claude,devin', '--seats', 'sam-agent', '--apply']);
    expect(JSON.parse(saved.out)).toMatchObject({ dry_run: false, written: true });
    expect(teamDirectory(team).people.find(p => p.displayName === 'Sam')).toMatchObject({ lanes: ['claude', 'devin'], seats: ['sam-agent'] });
  });
  it('refuses a duplicate name and unknown pools, saving nothing', async () => {
    asOwner();
    expect((await run(['add', 'Sam', '--pools', 'claude'])).code).toBe(0);
    const dup = await run(['add', 'sam', '--pools', 'claude']); expect(dup.code).toBe(1); expect(JSON.parse(dup.err).error).toMatch(/already exists/);
    const bad = await run(['add', 'Lee', '--pools', 'nowhere']); expect(bad.code).toBe(1); expect(JSON.parse(bad.err).error).toMatch(/Unknown pool nowhere/);
    expect(teamDirectory(team).people.map(p => p.displayName).sort()).toEqual(['Sam', 'owner']);
  });
  it('lists members with pools, and running jobs as unknown when the fleet cannot be read', async () => {
    asOwner(); await run(['add', 'Sam', '--pools', 'claude']);
    const listed = JSON.parse((await run(['list'])).out);
    const sam = listed.members.find((m: { display_name: string }) => m.display_name === 'Sam');
    expect(sam.pools).toEqual(['claude']); expect(sam.running_jobs).toHaveProperty('running');
  });
  it('counts only running jobs in the pools a member brings', async () => {
    const { memberRunningJobs } = await import('../src/core/teams/running-jobs.js');
    const sessions = [{ job: 'RQ-A', lane: 'claude', status: 'running' }, { job: 'RQ-B', lane: 'claude', status: 'queued' }, { job: 'RQ-C', lane: 'devin', status: 'running' }];
    const people = [{ ...ownerRow, id: 'p1', lanes: ['claude'] }, { ...ownerRow, id: 'p2', lanes: [] }] as never;
    expect(await memberRunningJobs(people, async () => ({ sessions }) as never)).toEqual({ p1: { running: 1, jobs: ['RQ-A'] }, p2: { running: 0, jobs: [] } });
    expect(await memberRunningJobs(people, async () => { throw new Error('x'); })).toEqual({ p1: { running: null, jobs: [] }, p2: { running: null, jobs: [] } });
  });
});
