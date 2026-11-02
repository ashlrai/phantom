/**
 * Identity layer: person, team and org. The person comes only from this
 * machine's own local auth (the OS user, optionally pinned by
 * `$ASHLR_HOME/teams/owner.json`); no token is read, copied or sent. Teams are
 * the local team bus (`phm team join`); orgs group teams in
 * `$ASHLR_HOME/tenancy/orgs.json`. All output is sorted and timestamp-free.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import { AGENT_ENV_MARKERS, localHumanName } from '../teams/identity.js';
import { foldTeam } from '../teams/state.js';
import { readEvents } from '../teams/store.js';
import { TenancyError, ownerKey, parseOwner, validOwner, type Owner } from './owner.js';

export * from './owner.js';

export interface Org { id: string; members: string[]; teams: string[] }
export interface Principal {
  schemaVersion: 1;
  person: string;
  /** `agent` when an agent runtime runs on the person's behalf with the same local auth. */
  actor: 'human' | 'agent';
  teams: { id: string; role: string }[];
  orgs: string[];
  /** Owner keys this principal may read and act for, sorted. */
  scopes: string[];
}

export const orgsPath = (): string => join(ashlrHome(), 'tenancy', 'orgs.json');
const sorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

function localPerson(): string {
  try { return localHumanName(); } catch (err) {
    throw new TenancyError(`Cannot derive your local identity: ${err instanceof Error ? err.message : String(err)}`,
      'Run phm from your own OS account, or fix $ASHLR_HOME/teams/owner.json ({"human":"<name>"}).');
  }
}

export function readOrgs(): Org[] {
  const file = orgsPath();
  if (!existsSync(file)) return [];
  const fix = `Fix the JSON in ${file} ({"version":1,"orgs":[{"id","members":[],"teams":[]}]}) or delete it and re-run \`phm org add <id>\`.`;
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new TenancyError(`${file} is not valid JSON.`, fix); }
  const orgs = (raw as { orgs?: unknown })?.orgs;
  const ids = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');
  if (!Array.isArray(orgs) || !orgs.every(o => validOwner({ kind: 'org', id: o?.id }) && ids(o.members) && ids(o.teams))) {
    throw new TenancyError(`${file} has an invalid org entry.`, fix);
  }
  return (orgs as Org[]).map(o => ({ id: o.id, members: sorted(o.members), teams: sorted(o.teams) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Humans admitted to a local team bus: joined from a human terminal or invited
 * by an owner/admin. Presence or a message under a claimed `--as` name never
 * admits anyone. A team nobody has joined yet is unclaimed.
 */
function teamHumans(team: string): Map<string, string> {
  let events;
  try { events = readEvents(team); } catch { return new Map(); }
  const admitted = new Set(events.flatMap(e => e.type === 'member.joined' && e.actor.kind === 'human' ? [e.actor.id]
    : e.type === 'member.invited' && typeof e.payload.memberId === 'string' ? [e.payload.memberId] : []));
  return new Map(foldTeam(team, events).members.filter(m => m.kind === 'human' && admitted.has(m.id))
    .map(m => [m.id.replace(/^human:/, ''), m.role]));
}

function localTeams(): string[] {
  const dir = join(ashlrHome(), 'teams');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory() && existsSync(join(dir, d.name, 'events.jsonl'))).map(d => d.name).sort();
}

export function whoami(env: NodeJS.ProcessEnv = process.env): Principal {
  const person = localPerson();
  const teams = localTeams().flatMap(id => { const role = teamHumans(id).get(person); return role ? [{ id, role }] : []; });
  const mine = new Set(teams.map(t => t.id));
  const orgs = readOrgs().filter(o => o.members.includes(person) || o.teams.some(t => mine.has(t))).map(o => o.id);
  const actor = AGENT_ENV_MARKERS.some(k => env[k] !== undefined && env[k] !== '') ? 'agent' : 'human';
  return { schemaVersion: 1, person, actor, teams, orgs,
    scopes: sorted([`person:${person}`, ...teams.map(t => `team:${t.id}`), ...orgs.map(o => `org:${o}`)]) };
}

export function orgList(): { schemaVersion: 1; person: string; orgs: Org[] } {
  const me = whoami();
  return { schemaVersion: 1, person: me.person, orgs: readOrgs().filter(o => me.orgs.includes(o.id)) };
}

/** Create or extend an org with yourself as a member; idempotent. */
export function orgAdd(id: string, teams: string[] = []): { schemaVersion: 1; action: 'created' | 'updated' | 'unchanged'; org: Org } {
  parseOwner(`org:${id}`);
  for (const t of teams) parseOwner(`team:${t}`);
  const person = localPerson();
  const orgs = readOrgs();
  const existing = orgs.find(o => o.id === id);
  const org = { id, members: sorted([...(existing?.members ?? []), person]), teams: sorted([...(existing?.teams ?? []), ...teams]) };
  const action = !existing ? 'created' : JSON.stringify(existing) === JSON.stringify(org) ? 'unchanged' : 'updated';
  if (action !== 'unchanged') {
    const file = orgsPath();
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const next = [...orgs.filter(o => o.id !== id), org].sort((a, b) => a.id.localeCompare(b.id));
    writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, orgs: next }, null, 2) + '\n', { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }
  return { schemaVersion: 1, action, org };
}

/** Throws a self-fixing TenancyError unless the local principal may act for `owner`. */
export function assertOwnerAccess(owner: Owner, principal: Principal = whoami()): void {
  if (principal.scopes.includes(ownerKey(owner))) return;
  const fix = owner.kind === 'team'
    ? `Ask a team owner to run \`phm team invite human:${principal.person} --team ${owner.id}\`.`
    : owner.kind === 'org'
      ? `Run \`phm org add ${owner.id}\` if you belong to it, or use one of your scopes (phm whoami --json).`
      : 'Another person owns this; use one of your own scopes (phm whoami --json).';
  throw new TenancyError(`${principal.person} is not in scope ${ownerKey(owner)}.`, fix);
}

/**
 * Forum threads and context packs live on a team bus. A team with no human
 * member yet is unclaimed and stays open; once claimed only its members (and
 * agents running under their local auth) may read or post.
 */
export function assertTeamAccess(team: string): void {
  const humans = teamHumans(team);
  if (humans.size === 0) return;
  const person = localPerson();
  if (humans.has(person)) return;
  throw new TenancyError(`Team "${team}" belongs to another tenant; ${person} is not a member.`,
    `Ask a team owner to run \`phm team invite human:${person} --team ${team}\`.`);
}
