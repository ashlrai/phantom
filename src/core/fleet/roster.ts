import { constants } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scrubPrivateText } from '../util/scrub.js';

export const SPECIALIST_ROSTER_SCHEMA = 'fleet-specialist-roster.v1' as const;
/** Descriptive coordination metadata; never a transport or execution grant. */
export interface SpecialistIdentity {
  role: string;
  capabilityTags: string[];
  machineAffinity: string[];
  laneAffinity: string[];
  peerIds: string[];
}
export interface Specialist {
  id: string;
  callsign: string;
  domain: string;
  identity?: SpecialistIdentity;
  allowedLanes: string[];
  allowedModels: string[];
  /** Relative to the roster directory; always memory/<id>.md. */
  memoryPath: string;
  currentJob: string | null;
  stats: { jobs: number; merges: number; reverts: number; emptyRate: number };
}
export interface SpecialistRoster {
  schema: typeof SPECIALIST_ROSTER_SCHEMA;
  specialists: Specialist[];
}
export type SpecialistOutcome = 'merged' | 'reverted' | 'empty' | 'completed' | 'failed';

export function specialistRosterDirectory(): string {
  return join(homedir(), '.ashlr-runs', 'queue', 'specialists');
}

export function validateSpecialistId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error('Invalid specialist id');
}

/** Pure, with explicit homes for callers that persist or export free text. */
export function specialistText(value: unknown, homes: readonly string[] = [], max = 2000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Invalid specialist text');
  const clean = scrubPrivateText(value, { homes })
    .replace(/\p{Cc}/gu, char => ['\n', '\r', '\t'].includes(char) ? char : '').trim();
  if (!clean) throw new Error('Invalid specialist text');
  return clean;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid specialist roster');
  return value as Record<string, unknown>;
}

/** Validate and project known fields only, scrubbing text even on reads. */
export function parseSpecialistRoster(value: unknown, homes: readonly string[] = []): SpecialistRoster {
  const roster = object(value);
  if (roster['schema'] !== SPECIALIST_ROSTER_SCHEMA || !Array.isArray(roster['specialists']) || roster['specialists'].length > 1000) {
    throw new Error('Invalid specialist roster');
  }
  const ids = new Set<string>();
  const peers = new Set<string>();
  const specialists = roster['specialists'].map((item: unknown): Specialist => {
    const row = object(item);
    const id = row['id'];
    validateSpecialistId(id);
    if (ids.has(id) || row['memoryPath'] !== `memory/${id}.md`) throw new Error('Invalid specialist identity');
    ids.add(id);
    const list = (value: unknown): string[] => {
      if (!Array.isArray(value) || value.length > 100) throw new Error('Invalid specialist allowlist');
      return [...new Set(value.map(v => specialistText(v, homes, 200)))];
    };
    const stats = object(row['stats']);
    let identity: SpecialistIdentity | undefined;
    if (row['identity'] !== undefined) {
      const metadata = object(row['identity']);
      identity = {
        role: specialistText(metadata['role'], homes, 200),
        capabilityTags: list(metadata['capabilityTags']), machineAffinity: list(metadata['machineAffinity']),
        laneAffinity: list(metadata['laneAffinity']), peerIds: list(metadata['peerIds']),
      };
      for (const peer of identity.peerIds) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(peer) || peers.has(peer)) throw new Error('Invalid specialist peer mapping');
        peers.add(peer);
      }
    }
    const count = (key: string): number => {
      const n = stats[key];
      if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw new Error('Invalid specialist statistics');
      return n;
    };
    const jobs = count('jobs'), merges = count('merges'), reverts = count('reverts');
    const emptyRate = stats['emptyRate'];
    if (merges > jobs || reverts > merges || typeof emptyRate !== 'number' || !Number.isFinite(emptyRate)
      || emptyRate < 0 || emptyRate > 1 || (jobs === 0 && emptyRate !== 0)) throw new Error('Invalid specialist statistics');
    return {
      id, callsign: specialistText(row['callsign'], homes, 200), domain: specialistText(row['domain'], homes),
      ...(identity ? { identity } : {}),
      allowedLanes: list(row['allowedLanes']), allowedModels: list(row['allowedModels']),
      memoryPath: `memory/${id}.md`,
      currentJob: row['currentJob'] === null ? null : specialistText(row['currentJob'], homes, 200),
      stats: { jobs, merges, reverts, emptyRate },
    };
  });
  return { schema: SPECIALIST_ROSTER_SCHEMA, specialists };
}

export function findSpecialist(roster: SpecialistRoster, id: string): Specialist {
  validateSpecialistId(id);
  const specialist = roster.specialists.find(row => row.id === id);
  if (!specialist) throw new Error('Unknown specialist');
  return specialist;
}

export function configureSpecialistIdentity(roster: SpecialistRoster, id: string, identity: SpecialistIdentity): SpecialistRoster {
  findSpecialist(roster, id);
  return parseSpecialistRoster({ ...roster, specialists: roster.specialists.map(row => row.id === id ? { ...row, identity } : row) });
}

/** Mapping lookup only; callers must still authenticate peers independently. */
export function specialistForPeer(roster: SpecialistRoster, peerId: string): Specialist | null {
  return parseSpecialistRoster(roster).specialists.find(row => row.identity?.peerIds.includes(peerId)) ?? null;
}

/** Assign creates a stable identity on first use, and preserves it on reassignment. */
export function assignSpecialist(roster: SpecialistRoster, id: string, domain: string): SpecialistRoster {
  validateSpecialistId(id);
  const existing = roster.specialists.find(row => row.id === id);
  const specialist: Specialist = existing ? { ...existing, domain } : {
    id, callsign: id, domain, allowedLanes: [], allowedModels: [], memoryPath: `memory/${id}.md`,
    currentJob: null, stats: { jobs: 0, merges: 0, reverts: 0, emptyRate: 0 },
  };
  return parseSpecialistRoster({ ...roster, specialists: [...roster.specialists.filter(row => row.id !== id), specialist] });
}

/** Job metadata only: this does not launch work or acquire a fleet claim. */
export function setSpecialistCurrentJob(roster: SpecialistRoster, id: string, job: string | null): SpecialistRoster {
  findSpecialist(roster, id);
  return parseSpecialistRoster({ ...roster, specialists: roster.specialists.map(row => row.id === id ? { ...row, currentJob: job } : row) });
}

/** One call per completed job. A reverted job counts as both merged and reverted. */
export function recordSpecialistOutcome(roster: SpecialistRoster, id: string, outcome: SpecialistOutcome): SpecialistRoster {
  if (!['merged', 'reverted', 'empty', 'completed', 'failed'].includes(outcome)) throw new Error('Invalid specialist outcome');
  const specialist = findSpecialist(roster, id);
  const stats = specialist.stats;
  const updated: Specialist = { ...specialist, currentJob: null, stats: {
    jobs: stats.jobs + 1,
    merges: stats.merges + (outcome === 'merged' || outcome === 'reverted' ? 1 : 0),
    reverts: stats.reverts + (outcome === 'reverted' ? 1 : 0),
    emptyRate: (stats.emptyRate * stats.jobs + (outcome === 'empty' ? 1 : 0)) / (stats.jobs + 1),
  } };
  return parseSpecialistRoster({ ...roster, specialists: roster.specialists.map(row => row.id === id ? updated : row) });
}

/** Missing is empty; malformed, oversized, symlinked, or unreadable state fails closed. */
export async function readSpecialistFile(path: string): Promise<string | null> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('Specialist state unavailable');
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Invalid specialist state file');
    return await file.readFile('utf8');
  } finally { await file.close(); }
}

export async function loadSpecialistRoster(directory = specialistRosterDirectory()): Promise<SpecialistRoster> {
  const raw = await readSpecialistFile(join(directory, 'roster.json'));
  return raw === null ? { schema: SPECIALIST_ROSTER_SCHEMA, specialists: [] }
    : parseSpecialistRoster(JSON.parse(raw), [homedir(), directory]);
}

/** Same-directory exclusive temp + rename: readers see a complete old or new snapshot. */
export async function saveSpecialistRoster(roster: SpecialistRoster, directory = specialistRosterDirectory()): Promise<void> {
  const clean = parseSpecialistRoster(roster, [homedir(), directory]);
  const payload = JSON.stringify(clean, null, 2) + '\n';
  if (Buffer.byteLength(payload) > 1024 * 1024) throw new Error('Specialist roster too large');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.roster-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(payload); await file.sync(); } finally { await file.close(); }
    await rename(temporary, join(directory, 'roster.json'));
  } finally { await unlink(temporary).catch(() => undefined); }
}

/** CLI writers serialize read/modify/write; an active or abandoned lock fails closed. */
export async function withSpecialistRosterLock<T>(directory: string, work: () => Promise<T>): Promise<T> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, '.roster.lock');
  const lock = await open(path, 'wx', 0o600);
  try { return await work(); }
  finally { await lock.close(); await unlink(path); }
}
