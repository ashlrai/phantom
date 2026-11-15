/**
 * One coordination table for resource, message, team, and board leases.
 * Claims coordinate work. They grant no execution authority.
 * Queued path scans stay a read-only observation merged by claimBoard().
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lstatSync, mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import { claimsOverlap, type ClaimTarget } from '../teams/protocol.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { ensurePrivateDirectory } from '../verse/preferences.js';
import { WORK_STATUSES, claimKeysOverlap, parseClaimKey } from './bus-v2-schema.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../fleet/local-store-lock.js';

export const COORDINATION_MAX_ROWS = 1024;
const MAX_BYTES = 512 * 1024;
const TEAM_MAX_LEASE_MS = 24 * 60 * 60 * 1000;
const RESOURCE_MAX_LEASE_MS = 3_600_000;
const LABEL = /^[\x21-\x7e]{1,256}$/;

export type CoordinationOrigin = 'resource' | 'message' | 'team' | 'board';
export type CoordinationState = 'live' | 'released' | 'completed';

interface StoredClaim {
  origin: CoordinationOrigin;
  key: string;
  owner: string;
  token: string;
  leaseMs: number;
  leaseUntil: number;
  state: CoordinationState;
  sourceId: string;
  repo: string | null;
  branch: string | null;
  path: string | null;
  /** Set when a work claim is acquired. Older rows omit it. */
  started?: string | null;
}

interface StoredStatus {
  jobId: string;
  owner: string;
  provider: string;
  repo: string;
  claimKeys: string[];
  status: string;
  updatedAt: number;
}

interface StoreFile { version: 1; claims: StoredClaim[]; statuses: StoredStatus[] }

export interface CoordinationView {
  origin: CoordinationOrigin | 'queue';
  key: string;
  owner: string;
  leaseUntil: number;
  sourceId: string;
  live: boolean;
  repo: string | null;
  branch: string | null;
  path: string | null;
  started: string | null;
}

export interface WorkStatusView {
  jobId: string;
  owner: string;
  provider: string;
  repo: string;
  claimKeys: string[];
  status: string;
  updatedAt: number;
}

export interface CoordinationHolder { owner: string; key: string; leaseUntil: number }
export type CoordinationResult =
  | { status: 'acquired' | 'renewed' | 'released' | 'completed'; token?: string; leaseUntil?: number }
  | { status: 'conflict'; holder: CoordinationHolder }
  | { status: 'mismatched-token' | 'expired' | 'lost' | 'invalid' | 'unavailable' | 'full' };

export interface CoordinationAcquire {
  root?: string;
  origin: CoordinationOrigin;
  key: string;
  owner: string;
  leaseMs: number;
  leaseUntil: number;
  sourceId: string;
  teamTarget?: ClaimTarget;
  now?: number;
  started?: string | null;
}

const empty = (): StoreFile => ({ version: 1, claims: [], statuses: [] });
const integer = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;

export function coordinationRoot(root?: string): string {
  return root ?? join(ashlrHome(), 'fleet');
}

function teamTargetOf(row: StoredClaim): ClaimTarget | null {
  if (!row.repo) return null;
  return { repo: row.repo, ...(row.branch ? { branch: row.branch } : {}), ...(row.path ? { path: row.path } : {}) };
}

function live(row: StoredClaim, now: number): boolean {
  return row.state === 'live' && now < row.leaseUntil;
}

function normPath(path: string): string {
  return path.replace(/^\.?\/+/, '').replace(/\/+$/, '');
}

function pathsOverlap(teamPath: string, glob: string): boolean {
  const left = normPath(teamPath);
  const right = normPath(glob);
  if (!left || !right || left.split('/').includes('..') || right.split('/').includes('..')) return false;
  const wild = (value: string) => /[*?[{]/.test(value);
  if (!wild(left) && !wild(right)) return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
  const sampleRepo = 'o/n';
  return claimKeysOverlap(`path:${sampleRepo}:${left}`, `path:${sampleRepo}:${right}`);
}

function teamHitsKey(target: ClaimTarget, key: string): boolean {
  const parsed = parseClaimKey(key);
  if (!parsed || parsed.kind === 'queue') return false;
  if (parsed.repo !== target.repo.toLowerCase()) return false;
  if (!target.path) return parsed.kind === 'repo' || parsed.kind === 'path' || parsed.kind === 'pr';
  if (parsed.kind === 'repo') return true;
  if (parsed.kind === 'path') return pathsOverlap(target.path, parsed.glob);
  return false;
}

function overlaps(a: StoredClaim, b: StoredClaim, now: number): boolean {
  if (!live(a, now) || !live(b, now)) return false;
  if (a.origin === 'team' && b.origin === 'team') {
    const left = teamTargetOf(a);
    const right = teamTargetOf(b);
    return Boolean(left && right && claimsOverlap(left, right));
  }
  if (a.origin === 'team') {
    const target = teamTargetOf(a);
    return Boolean(target && (teamHitsKey(target, b.key) || a.key === b.key));
  }
  if (b.origin === 'team') {
    const target = teamTargetOf(b);
    return Boolean(target && (teamHitsKey(target, a.key) || a.key === b.key));
  }
  return a.key === b.key || claimKeysOverlap(a.key, b.key);
}

function validLease(origin: CoordinationOrigin, leaseMs: number): boolean {
  const max = origin === 'team' || origin === 'board' ? TEAM_MAX_LEASE_MS : RESOURCE_MAX_LEASE_MS;
  return integer(leaseMs) && leaseMs >= 1 && leaseMs <= max;
}

function validAcquire(input: CoordinationAcquire, now: number): boolean {
  if (!['resource', 'message', 'team', 'board'].includes(input.origin)) return false;
  if (!LABEL.test(input.key) || !LABEL.test(input.owner) || !LABEL.test(input.sourceId)) return false;
  if (!validLease(input.origin, input.leaseMs) || !integer(input.leaseUntil) || input.leaseUntil <= now) return false;
  if (input.leaseUntil - now > input.leaseMs) return false;
  if (input.origin === 'resource' || input.origin === 'message') return parseClaimKey(input.key) !== undefined;
  if (input.origin === 'team') {
    return Boolean(input.teamTarget && /^[\w.-]+\/[\w.-]+$/.test(input.teamTarget.repo) && input.key.startsWith('team:'));
  }
  return input.key.startsWith('board:') || parseClaimKey(input.key)?.kind === 'queue';
}

function tokensMatch(stored: string, presented: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(stored) || !/^[a-f0-9]{64}$/.test(presented)) return false;
  return timingSafeEqual(Buffer.from(stored), Buffer.from(presented));
}

function privateDirectory(path: string, anchor: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory() ||
    (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
    (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o700) ||
    !assurePrivateStoragePath(path, 'directory', 'inspect-existing', { anchorPath: anchor }).ok) {
    throw new Error('Unavailable');
  }
}

function directoryFor(root: string): string {
  if (!isAbsolute(root) || root.includes('\0')) throw new Error('Unavailable');
  ensurePrivateDirectory(root);
  const directory = join(root, 'coordination');
  try { mkdirSync(directory, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  privateDirectory(directory, root);
  return directory;
}

function claimOk(row: unknown): row is StoredClaim {
  if (!row || typeof row !== 'object') return false;
  const value = row as StoredClaim;
  return (['resource', 'message', 'team', 'board'] as const).includes(value.origin) &&
    (['live', 'released', 'completed'] as const).includes(value.state) &&
    LABEL.test(value.key) && LABEL.test(value.owner) && /^[a-f0-9]{64}$/.test(value.token) &&
    LABEL.test(value.sourceId) && validLease(value.origin, value.leaseMs) && integer(value.leaseUntil) &&
    (value.repo === null || typeof value.repo === 'string') &&
    (value.branch === null || typeof value.branch === 'string') &&
    (value.path === null || typeof value.path === 'string') &&
    (value.started === undefined || value.started === null || (typeof value.started === 'string' && Number.isFinite(Date.parse(value.started))));
}

function statusOk(row: unknown): row is StoredStatus {
  if (!row || typeof row !== 'object') return false;
  const value = row as StoredStatus;
  return LABEL.test(value.jobId) && LABEL.test(value.owner) && LABEL.test(value.provider) &&
    /^[\w.-]+\/[\w.-]+$/.test(value.repo) && Array.isArray(value.claimKeys) && value.claimKeys.length <= 16 &&
    value.claimKeys.every(key => typeof key === 'string' && parseClaimKey(key) !== undefined) &&
    (WORK_STATUSES as readonly string[]).includes(value.status) && integer(value.updatedAt);
}

function readStore(root: string): { directory: string; file: string; data: StoreFile } {
  const directory = directoryFor(root);
  const file = join(directory, 'claims.json');
  let data = empty();
  try { lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { directory, file, data };
    throw error;
  }
  const read = readStableRegularFile(file, { anchorPath: root, maxFileBytes: MAX_BYTES, remainingBytes: MAX_BYTES });
  if (!read.ok) throw new Error('Unavailable');
  const parsed = JSON.parse(read.text) as StoreFile;
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.claims) || !Array.isArray(parsed.statuses) ||
    parsed.claims.length > COORDINATION_MAX_ROWS || parsed.statuses.length > COORDINATION_MAX_ROWS ||
    parsed.claims.some(row => !claimOk(row)) || parsed.statuses.some(row => !statusOk(row))) {
    throw new Error('Unavailable');
  }
  data = parsed;
  return { directory, file, data };
}

function persist(root: string, directory: string, file: string, data: StoreFile, now: number): void {
  data.claims = data.claims.filter(row => live(row, now));
  const json = JSON.stringify(data);
  if (data.claims.length > COORDINATION_MAX_ROWS || data.statuses.length > COORDINATION_MAX_ROWS ||
    Buffer.byteLength(json) > MAX_BYTES) throw new Error('Full');
  const pending = join(directory, '.pending');
  writePrivateFileAtomically(pending, file, json, { anchorPath: root, label: 'Coordination claims' });
}

function withStore<T>(root: string | undefined, now: number, work: (data: StoreFile) => T): T | CoordinationResult {
  const resolved = coordinationRoot(root);
  let lock: ReturnType<typeof acquireLocalStoreLockWithOutcome> | undefined;
  try {
    const opened = readStore(resolved);
    lock = acquireLocalStoreLockWithOutcome(join(opened.directory, 'writer.lock'), 0, { anchorPath: resolved, exactPrivateStorage: true });
    if (lock.state !== 'acquired') return { status: lock.state === 'contended' ? 'unavailable' : 'unavailable' };
    const fresh = readStore(resolved);
    const result = work(fresh.data);
    persist(resolved, fresh.directory, fresh.file, fresh.data, now);
    return result;
  } catch (error) {
    if (error instanceof Error && error.message === 'Full') return { status: 'full' };
    return { status: 'unavailable' };
  } finally {
    if (lock?.state === 'acquired') releaseLocalStoreLock(lock.lock);
  }
}

function view(row: StoredClaim, now: number): CoordinationView {
  return {
    origin: row.origin, key: row.key, owner: row.owner, leaseUntil: row.leaseUntil, sourceId: row.sourceId,
    live: live(row, now), repo: row.repo, branch: row.branch, path: row.path,
    started: typeof row.started === 'string' ? row.started : null,
  };
}

function peekStore(root: string): StoreFile | 'missing' {
  const file = join(root, 'coordination', 'claims.json');
  try { lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
  const read = readStableRegularFile(file, { anchorPath: root, maxFileBytes: MAX_BYTES, remainingBytes: MAX_BYTES });
  if (!read.ok) throw new Error('Unavailable');
  const parsed = JSON.parse(read.text) as StoreFile;
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.claims) || !Array.isArray(parsed.statuses) ||
    parsed.claims.length > COORDINATION_MAX_ROWS || parsed.statuses.length > COORDINATION_MAX_ROWS ||
    parsed.claims.some(row => !claimOk(row)) || parsed.statuses.some(row => !statusOk(row))) {
    throw new Error('Unavailable');
  }
  return parsed;
}

export function listCoordination(root?: string, now = Date.now()): {
  source: 'missing' | 'available' | 'unavailable';
  claims: CoordinationView[];
  statuses: WorkStatusView[];
} {
  try {
    const peeked = peekStore(coordinationRoot(root));
    if (peeked === 'missing') return { source: 'missing', claims: [], statuses: [] };
    return {
      source: 'available',
      claims: peeked.claims.map(row => view(row, now)),
      statuses: peeked.statuses.map(row => ({ ...row, claimKeys: [...row.claimKeys] })),
    };
  } catch {
    return { source: 'unavailable', claims: [], statuses: [] };
  }
}

export function coordinationSummary(root?: string, now = Date.now()): {
  source: 'missing' | 'available' | 'unavailable';
  liveClaims: number | null;
  statuses: number | null;
} {
  const listed = listCoordination(root, now);
  if (listed.source !== 'available') return { source: listed.source, liveClaims: null, statuses: null };
  return { source: 'available', liveClaims: listed.claims.filter(row => row.live).length, statuses: listed.statuses.length };
}

/** Read-only queue prompt paths, shown beside leases. They are not leases. */
export function observeQueuedPaths(claims: ReadonlyMap<string, readonly string[]>, repo = 'local/queue'): CoordinationView[] {
  const rows: CoordinationView[] = [];
  for (const [path, jobs] of claims) {
    const key = `path:${repo}:${normPath(path)}`;
    if (!parseClaimKey(key)) continue;
    rows.push({
      origin: 'queue', key, owner: jobs.join(','), leaseUntil: 0, sourceId: `queued:${normPath(path)}`,
      live: false, repo, branch: null, path: normPath(path), started: null,
    });
  }
  return rows;
}

export function claimBoard(input: { root?: string; queued?: ReadonlyMap<string, readonly string[]>; repo?: string; now?: number } = {}): {
  source: 'missing' | 'available' | 'unavailable';
  claims: CoordinationView[];
  observations: CoordinationView[];
  statuses: WorkStatusView[];
} {
  const listed = listCoordination(input.root, input.now);
  return {
    source: listed.source,
    claims: listed.claims.filter(row => row.live),
    observations: input.queued ? observeQueuedPaths(input.queued, input.repo) : [],
    statuses: listed.statuses,
  };
}

export function acquireCoordination(input: CoordinationAcquire): CoordinationResult {
  const now = input.now ?? Date.now();
  if (!validAcquire(input, now)) return { status: 'invalid' };
  const target = input.teamTarget;
  const drafted: StoredClaim = {
    origin: input.origin, key: input.key, owner: input.owner, token: randomBytes(32).toString('hex'),
    leaseMs: input.leaseMs, leaseUntil: input.leaseUntil, state: 'live', sourceId: input.sourceId,
    repo: target?.repo ?? null, branch: target?.branch ?? null, path: target?.path ?? null,
    started: input.started ?? null,
  };
  const outcome = withStore(input.root, now, data => {
    const conflict = data.claims.find(row => overlaps(row, drafted, now) &&
      !(row.origin === drafted.origin && row.sourceId === drafted.sourceId) &&
      !(drafted.origin === 'team' && row.owner === drafted.owner));
    if (conflict) return { status: 'conflict' as const, holder: { owner: conflict.owner, key: conflict.key, leaseUntil: conflict.leaseUntil } };
    const index = data.claims.findIndex(row => row.origin === drafted.origin && row.sourceId === drafted.sourceId);
    if (index >= 0) data.claims[index] = drafted;
    else data.claims.push(drafted);
    return { status: 'acquired' as const, token: drafted.token, leaseUntil: drafted.leaseUntil };
  });
  return outcome as CoordinationResult;
}

export function renewCoordination(input: {
  root?: string; key: string; token: string; leaseUntil: number; now?: number;
}): CoordinationResult {
  const now = input.now ?? Date.now();
  if (!LABEL.test(input.key) || !integer(input.leaseUntil) || input.leaseUntil <= now) return { status: 'invalid' };
  const outcome = withStore(input.root, now, data => {
    const row = data.claims.find(item => item.key === input.key && item.state === 'live');
    if (!row) return { status: 'lost' as const };
    if (!live(row, now)) return { status: 'expired' as const };
    if (!tokensMatch(row.token, input.token)) return { status: 'mismatched-token' as const };
    if (input.leaseUntil - now > row.leaseMs) return { status: 'invalid' as const };
    row.leaseUntil = input.leaseUntil;
    return { status: 'renewed' as const, leaseUntil: row.leaseUntil };
  });
  return outcome as CoordinationResult;
}

export function settleCoordination(input: {
  root?: string; key: string; token: string; outcome: 'released' | 'completed'; now?: number;
}): CoordinationResult {
  const now = input.now ?? Date.now();
  if (!LABEL.test(input.key) || (input.outcome !== 'released' && input.outcome !== 'completed')) return { status: 'invalid' };
  const outcome = withStore(input.root, now, data => {
    const index = data.claims.findIndex(item => item.key === input.key && item.state === 'live');
    const row = index >= 0 ? data.claims[index] : undefined;
    if (!row) return { status: 'lost' as const };
    if (!live(row, now)) return { status: 'expired' as const };
    if (!tokensMatch(row.token, input.token)) return { status: 'mismatched-token' as const };
    data.claims.splice(index, 1);
    return { status: input.outcome };
  });
  return outcome as CoordinationResult;
}

export function releaseCoordinationBySource(input: {
  root?: string; origin: CoordinationOrigin; sourceId: string; now?: number;
}): CoordinationResult {
  const now = input.now ?? Date.now();
  if (!LABEL.test(input.sourceId)) return { status: 'invalid' };
  const outcome = withStore(input.root, now, data => {
    const before = data.claims.length;
    data.claims = data.claims.filter(row => !(row.origin === input.origin && row.sourceId === input.sourceId));
    return before === data.claims.length ? { status: 'lost' as const } : { status: 'released' as const };
  });
  return outcome as CoordinationResult;
}

export function boardClaimKey(itemId: string): string {
  const queue = `queue:${itemId}`;
  return parseClaimKey(queue) ? queue : `board:${itemId}`;
}

export function upsertBoardLease(input: {
  root?: string; sourceId: string; owner: string; leaseUntil: number; now?: number;
}): CoordinationResult {
  const now = input.now ?? Date.now();
  if (!LABEL.test(input.sourceId) || !LABEL.test(input.owner) || !integer(input.leaseUntil) || input.leaseUntil <= now) {
    return { status: 'invalid' };
  }
  const leaseMs = Math.min(TEAM_MAX_LEASE_MS, input.leaseUntil - now);
  return acquireCoordination({
    root: input.root, origin: 'board', key: boardClaimKey(input.sourceId), owner: input.owner,
    leaseMs, leaseUntil: now + leaseMs, sourceId: input.sourceId, now,
  });
}

export function clearBoardLease(sourceId: string, root?: string, now = Date.now()): CoordinationResult {
  const result = releaseCoordinationBySource({ root, origin: 'board', sourceId, now });
  return result.status === 'lost' ? { status: 'released' } : result;
}

/** Drop one live lease when the caller is the owner. A different holder is a conflict. The token stays in the store. */
export function releaseLiveClaimByOwner(input: { root?: string; key: string; owner: string; now?: number }): CoordinationResult {
  const now = input.now ?? Date.now();
  if (!LABEL.test(input.key) || !LABEL.test(input.owner)) return { status: 'invalid' };
  const outcome = withStore(input.root, now, data => {
    const index = data.claims.findIndex(row => row.key === input.key && live(row, now));
    const row = index >= 0 ? data.claims[index] : undefined;
    if (!row) return { status: 'lost' as const };
    if (row.owner !== input.owner) {
      return { status: 'conflict' as const, holder: { owner: row.owner, key: row.key, leaseUntil: row.leaseUntil } };
    }
    data.claims.splice(index, 1);
    return { status: 'released' as const };
  });
  return outcome as CoordinationResult;
}

export function setWorkStatus(input: {
  root?: string; jobId: string; owner: string; provider: string; repo: string;
  claimKeys: string[]; status: string; updatedAt?: number;
}): CoordinationResult {
  const now = input.updatedAt ?? Date.now();
  const row: StoredStatus = {
    jobId: input.jobId, owner: input.owner, provider: input.provider, repo: input.repo,
    claimKeys: input.claimKeys, status: input.status, updatedAt: now,
  };
  if (!statusOk(row)) return { status: 'invalid' };
  const outcome = withStore(input.root, now, data => {
    const index = data.statuses.findIndex(item => item.jobId === row.jobId);
    if (index >= 0) data.statuses[index] = row;
    else data.statuses.push(row);
    return { status: 'acquired' as const };
  });
  return outcome as CoordinationResult;
}

export function teamClaimKey(target: ClaimTarget): string {
  return `team:${target.repo.toLowerCase()}:${target.branch ?? ''}:${target.path ?? ''}`;
}
