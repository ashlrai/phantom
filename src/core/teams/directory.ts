/** Directory metadata shares the team log; it never grants membership or opts in a lane. */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { directorySchema, personInputSchema, personSchema, type TeamDirectory, type TeamPerson } from '../../shared/team-directory.js';
import { assertMetadata } from '../connectors/profile.js';
import { loadOrg, orgFile, type Org } from '../org/org.js';
import { appendUnlocked, readEvents, withTeamLock } from './store.js';
import { foldTeam } from './state.js';
import type { TeamEvent } from './protocol.js';

export class DirectoryInputError extends Error {}
const invalid = (): never => { throw new DirectoryInputError('Invalid teammate. Use a display name, role, contact identities, lane names and seat names only.'); };

export function foldDirectory(team: string, events: TeamEvent[], org: Org | null): TeamDirectory {
  events = events.filter(ev => ev.team === team);
  const people = new Map<string, TeamPerson>();
  const members = foldTeam(team, events).members;
  for (const m of members.filter(m => m.kind === 'human')) people.set(m.id, {
    id: m.id, displayName: m.id.slice(6), role: m.role === 'owner' ? 'founder' : 'engineer', identities: [],
    lanes: [], seats: members.filter(a => a.kind === 'agent' && a.onBehalfOf === m.id).map(a => a.id), status: 'member',
  });
  // org.toml is node-wide; never expose its people in another team's directory.
  if (team === 'default') for (const m of org?.members ?? []) people.set(`human:${m.id}`, {
    id: `human:${m.id}`, displayName: m.name, role: m.role === 'member' ? 'engineer' : 'founder', identities: [],
    lanes: m.contributions.map(c => c.lane), seats: m.agents.map(a => a.id), status: 'member',
  });
  for (const ev of events) {
    if (ev.type === 'person.added') {
      // Verified evidence may be replayed from a trusted local log; add never creates it.
      const parsed = personSchema.safeParse(ev.payload.person);
      if (!parsed.success) throw new Error('Team directory record unavailable.');
      people.set(parsed.data.id, parsed.data);
    } else if (ev.type === 'person.removed' && typeof ev.payload.id === 'string' && ev.payload.id.startsWith('person:')) {
      people.delete(ev.payload.id);
    }
  }
  const result: TeamDirectory = { version: 1, team, people: [...people.values()], orgState: team === 'default' && org ? 'available' : 'absent' };
  assertMetadata(JSON.stringify(result));
  return directorySchema.parse(result);
}

export function teamDirectory(team: string): TeamDirectory {
  let org: Org | null = null, unknown = false;
  try { if (team === 'default' && existsSync(orgFile())) org = loadOrg(); } catch { unknown = true; }
  const result = foldDirectory(team, readEvents(team), org);
  if (unknown) result.orgState = 'unknown';
  return result;
}

export function addTeamPerson(team: string, input: unknown) {
  try { assertMetadata(JSON.stringify(input)); } catch { return invalid(); }
  const parsed = personInputSchema.safeParse(input);
  if (!parsed.success) return invalid();
  const p = parsed.data;
  return withTeamLock(team, () => {
    const identities: TeamPerson['identities'] = (['email', 'slack', 'phone'] as const).flatMap(kind => p[kind] ? [{ kind, value: p[kind]!, state: 'pending' as const }] : []);
    if (teamDirectory(team).people.some(m => m.displayName.toLowerCase() === p.displayName.toLowerCase() ||
      m.identities.some(i => identities.some(j => i.kind === j.kind && i.value.toLowerCase() === j.value.toLowerCase())))) {
      throw new DirectoryInputError('Teammate already exists. Use phm team list to review.');
    }
    const person: TeamPerson = { id: `person:${randomUUID()}`, displayName: p.displayName, role: p.role, identities,
      lanes: [...new Set(p.lanes)], seats: [...new Set(p.seats)], status: 'pending' };
    appendUnlocked(team, { kind: 'agent', id: 'agent:team-directory' }, 'person.added', { person });
    return { version: 1 as const, person, next: 'Ask the team owner to verify this teammate through a known contact channel. Nothing has been sent.' };
  });
}

export function removeTeamPerson(team: string, id: string) {
  return withTeamLock(team, () => {
    const person = teamDirectory(team).people.find(p => p.id === id);
    if (!id.startsWith('person:') || person?.status !== 'pending') throw new DirectoryInputError('Only pending directory records can be removed here. Use the existing membership removal flow for members.');
    appendUnlocked(team, { kind: 'agent', id: 'agent:team-directory' }, 'person.removed', { id });
    return { version: 1 as const, removed: id };
  });
}
