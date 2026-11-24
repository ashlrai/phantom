/** Directory metadata shares the team log; it never grants membership or opts in a lane. */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { directorySchema, isOwner, personInputSchema, personSchema, shareTotal, TEAM_SCHEMA, toMember, type TeamDirectory, type TeamPerson } from '../../shared/team-directory.js';
import { DROP_JOB_LANES } from '../fleet/drop-job-writer.js';
import { BUS_MIRROR_KNOWN_LANES } from '../fleet/bus-mirror-dispatch.js';
import { assertMetadata } from '../connectors/profile.js';
import { loadOrg, orgFile, type Org } from '../org/org.js';
import { appendUnlocked, readEvents, withTeamLock } from './store.js';
import { foldTeam } from './state.js';
import type { TeamActor, TeamEvent } from './protocol.js';
import { updateWorkspace } from './workspace.js';

export class DirectoryInputError extends Error {}
/** The caller is not allowed to change the team. Distinct from bad input so surfaces can answer 403. */
export class DirectoryRefusedError extends DirectoryInputError {}
export const OWNER_ONLY = 'Only a team owner can add or remove teammates, from their own terminal.';
/** `actor` must be a verified human principal, never a flag or request field. */
function assertOwner(directory: TeamDirectory, actor: TeamActor): void {
  const owners = directory.people.filter(isOwner);
  if (!owners.length) throw new DirectoryRefusedError(`This team has no owner yet. Run phm team join --team ${directory.team} first; the first person to join becomes the owner.`);
  if (actor.kind !== 'human' || !owners.some(p => p.id === actor.id)) throw new DirectoryRefusedError(OWNER_ONLY);
}
/** Pools a teammate can bring: the dispatch lanes plus any lane already on this team's record. */
export const knownPools = (directory?: TeamDirectory): string[] =>
  [...new Set([...DROP_JOB_LANES, ...BUS_MIRROR_KNOWN_LANES, ...(directory?.people.flatMap(p => p.lanes) ?? [])])].sort();
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
  const result: TeamDirectory = { schema: TEAM_SCHEMA, version: 1, team, people: [...people.values()], orgState: team === 'default' && org ? 'available' : 'absent' };
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

/** `dryRun` runs every check and returns the record that would be saved, writing nothing. */
export function addTeamPerson(team: string, actor: TeamActor, input: unknown, options: { dryRun?: boolean } = {}) {
  try { assertMetadata(JSON.stringify(input)); } catch { return invalid(); }
  const parsed = personInputSchema.safeParse(input);
  if (!parsed.success) return invalid();
  const p = parsed.data;
  return withTeamLock(team, () => {
    const directory = teamDirectory(team);
    assertOwner(directory, actor);
    // Only the owner's own check makes a sender id verified; without it messages from that id stay unverified.
    const state = p.verified ? 'verified' as const : 'pending' as const;
    const identities: TeamPerson['identities'] = (['email', 'slack', 'phone'] as const).flatMap(kind => p[kind] ? [{ kind, value: p[kind]!, state }] : []);
    if (directory.people.some(m => m.displayName.toLowerCase() === p.displayName.toLowerCase() ||
      m.identities.some(i => identities.some(j => i.kind === j.kind && i.value.toLowerCase() === j.value.toLowerCase())))) {
      throw new DirectoryInputError('Teammate already exists. Use phm team list to review.');
    }
    const unknown = p.lanes.filter(lane => !knownPools(directory).includes(lane));
    if (unknown.length) throw new DirectoryInputError(`Unknown pool ${unknown.join(', ')}. Known pools: ${knownPools(directory).join(', ')}.`);
    const total = shareTotal(directory.people) + (p.poolSharePct ?? 0);
    if (total > 100) throw new DirectoryInputError(`Pool shares would add up to ${total}%. Keep the total at 100 or less.`);
    const person: TeamPerson = { id: `person:${randomUUID()}`, displayName: p.displayName, role: p.role, identities,
      lanes: [...new Set(p.lanes)], seats: [...new Set(p.seats)], status: 'pending',
      ...(p.poolSharePct !== undefined ? { poolSharePct: p.poolSharePct } : {}),
      ...(p.allowedRepos?.length ? { allowedRepos: [...new Set(p.allowedRepos.map(r => r.toLowerCase()))] } : {}),
      createdAt: new Date().toISOString() };
    if (!options.dryRun) appendUnlocked(team, actor, 'person.added', { person });
    // Phantom never contacts the teammate: the owner passes this note on in their own words and channel.
    const note = `You have a seat on our Phantom team${person.poolSharePct ? `, with ${person.poolSharePct}% of the shared pool` : ''}. Install Phantom, tell me when you are ready, and I will give you an invite to run with: phm team join <invite>`;
    // Joining from another machine is the existing node pairing; this record never builds a second one.
    return { schema: TEAM_SCHEMA, version: 1 as const, dry_run: !!options.dryRun, written: !options.dryRun, person, member: toMember(person), note,
      next: options.dryRun ? `Dry run: nothing was saved. Run the same command with --apply to save it. Their other computer joins with phm node join (docs/NODES.md).`
      : `Saved on this machine only. Nothing was sent: share the note with ${person.displayName} yourself.${identities.length && !p.verified ? ' Their sender ids are pending; add with --verified once you have checked them.' : ''} Their other computer joins with phm node join (docs/NODES.md).` };
  });
}

/** Removes a pending record, or a joined member through the existing membership removal. Never the last owner. */
export function removeTeamPerson(team: string, actor: TeamActor, id: string) {
  const pending = withTeamLock(team, () => {
    const directory = teamDirectory(team);
    assertOwner(directory, actor);
    const person = directory.people.find(p => p.id === id);
    if (!person) throw new DirectoryInputError('Teammate not found. Use phm team list.');
    if (isOwner(person) && directory.people.filter(isOwner).length <= 1) throw new DirectoryRefusedError('The last owner cannot be removed. Add another owner first.');
    if (person.status === 'pending') appendUnlocked(team, actor, 'person.removed', { id });
    return person.status === 'pending';
  });
  // Joined members leave through the audited membership path, which also drains their claims.
  if (!pending) updateWorkspace(team, actor, { type: 'member.removed', memberId: id });
  return { schema: TEAM_SCHEMA, version: 1 as const, removed: id };
}
