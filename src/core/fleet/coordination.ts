/** Host-only advisory coordination. A lease never authorizes execution or spawns work. */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { acquireLocalStoreLock, ownsLocalStoreLock, releaseLocalStoreLock } from './local-store-lock.js';
import { scrubSecrets } from '../util/scrub.js';
import { fsyncDirectory } from '../util/durability.js';

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 20_000;
export const FLEET_CLAIM_TTL_MS = 60 * 60_000;
const MAX_TTL_MS = 7 * 24 * FLEET_CLAIM_TTL_MS;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
export interface FleetCoordinationOptions { path?: string; now?: number }
export interface FleetClaim { id: string; repo: string; task: string; agent: string; claimedAt: number; expiresAt: number }
export interface FleetMessage { id: string; from: string; to: string; body: string; at: number; expiresAt: number }
export interface FleetAssignment { id: string; repo: string; task: string; to: string; at: number; expiresAt: number; executionAuthorized: false }
export interface FleetBoard {
  schema: 'fleet.coordination.v1'; state: 'known' | 'unknown'; claims: FleetClaim[];
  messages: FleetMessage[]; proposals: FleetAssignment[]; expiredClaims: number | null;
}
interface OwnedClaim extends FleetClaim { leaseHash: string }
type Event =
  | { version: 1; kind: 'claim' | 'handoff'; at: number; claim: OwnedClaim }
  | { version: 1; kind: 'release' | 'reap'; at: number; id: string }
  | { version: 1; kind: 'post'; at: number; message: FleetMessage }
  | { version: 1; kind: 'assign'; at: number; proposal: FleetAssignment };
interface State { claims: Map<string, OwnedClaim>; messages: FleetMessage[]; proposals: FleetAssignment[] }
export type FleetCoordinationResult<T> = { ok: true; value: T } | { ok: false; error: 'invalid-input' | 'unavailable' | 'duplicate' | 'not-owner' | 'not-found' };
export function fleetCoordinationPath(): string {
  return resolve(process.env['PHANTOM_FLEET_LEDGER_PATH'] ?? join(process.env['ASHLR_HOME'] ?? join(homedir(), '.ashlr'), 'fleet', 'coordination.jsonl'));
}
function hash(lease: string): string { return createHash('sha256').update(lease).digest('hex'); }
function text(value: unknown, max = 1000): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && ![...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}
function ident(value: unknown): value is string { return typeof value === 'string' && ID.test(value); }
function timestamp(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exact(value: Record<string, unknown>, keys: string[]): boolean { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
function claimShape(value: unknown): value is OwnedClaim {
  return object(value) && exact(value, ['id', 'repo', 'task', 'agent', 'claimedAt', 'expiresAt', 'leaseHash']) && ident(value.id)
    && typeof value.repo === 'string' && REPO.test(value.repo) && text(value.task) && ident(value.agent)
    && timestamp(value.claimedAt) && timestamp(value.expiresAt) && value.expiresAt > value.claimedAt
    && typeof value.leaseHash === 'string' && /^[a-f0-9]{64}$/.test(value.leaseHash);
}
function messageShape(value: unknown): value is FleetMessage {
  return object(value) && exact(value, ['id', 'from', 'to', 'body', 'at', 'expiresAt']) && ident(value.id) && ident(value.from)
    && ident(value.to) && text(value.body, 4000) && timestamp(value.at) && timestamp(value.expiresAt) && value.expiresAt > value.at;
}
function assignmentShape(value: unknown): value is FleetAssignment {
  return object(value) && exact(value, ['id', 'repo', 'task', 'to', 'at', 'expiresAt', 'executionAuthorized']) && ident(value.id)
    && typeof value.repo === 'string' && REPO.test(value.repo) && text(value.task) && ident(value.to)
    && timestamp(value.at) && timestamp(value.expiresAt) && value.expiresAt > value.at && value.executionAuthorized === false;
}
function parseEvent(value: unknown): Event {
  if (!object(value) || value.version !== 1 || !timestamp(value.at)) throw new Error('Invalid ledger');
  if ((value.kind === 'claim' || value.kind === 'handoff') && exact(value, ['version', 'kind', 'at', 'claim']) && claimShape(value.claim)) return value as unknown as Event;
  if ((value.kind === 'release' || value.kind === 'reap') && exact(value, ['version', 'kind', 'at', 'id']) && ident(value.id)) return value as unknown as Event;
  if (value.kind === 'post' && exact(value, ['version', 'kind', 'at', 'message']) && messageShape(value.message)) return value as unknown as Event;
  if (value.kind === 'assign' && exact(value, ['version', 'kind', 'at', 'proposal']) && assignmentShape(value.proposal)) return value as unknown as Event;
  throw new Error('Invalid ledger');
}
function privateFile(fd: number): Stats {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1 || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0 || stat.size > MAX_BYTES) throw new Error('Unsafe ledger');
  return stat;
}
function readEvents(path: string, allowMissing = false): { events: Event[]; stat: Stats | null } {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = privateFile(fd);
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) { const n = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!n) throw new Error('Short ledger'); offset += n; }
    const after = privateFile(fd);
    const named = lstatSync(path);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || named.ino !== before.ino || named.dev !== before.dev || named.isSymbolicLink()) throw new Error('Changing ledger');
    const raw = bytes.toString('utf8');
    if (raw && !raw.endsWith('\n')) throw new Error('Torn ledger');
    const lines = raw ? raw.slice(0, -1).split('\n') : [];
    if (lines.length > MAX_ROWS) throw new Error('Ledger limit');
    return { events: lines.map(line => parseEvent(JSON.parse(line))), stat: before };
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return { events: [], stat: null };
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}
function replay(events: Event[]): State {
  const state: State = { claims: new Map(), messages: [], proposals: [] };
  for (const event of events) {
    if (event.kind === 'claim' || event.kind === 'handoff') state.claims.set(event.claim.id, event.claim);
    else if (event.kind === 'release' || event.kind === 'reap') state.claims.delete(event.id);
    else if (event.kind === 'post') state.messages.push(event.message);
    else if (event.kind === 'assign') state.proposals.push(event.proposal);
  }
  return state;
}
function stateEvents(state: State): Event[] {
  return [
    ...[...state.claims.values()].map((claim): Event => ({ version: 1, kind: 'claim', at: claim.claimedAt, claim })),
    ...state.messages.map((message): Event => ({ version: 1, kind: 'post', at: message.at, message })),
    ...state.proposals.map((proposal): Event => ({ version: 1, kind: 'assign', at: proposal.at, proposal })),
  ];
}
function encodeEvents(events: Event[]): Buffer {
  return Buffer.from(events.map(event => JSON.stringify(event) + '\n').join(''));
}
function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (!written) throw new Error('Short ledger write');
    offset += written;
  }
}
function requireUnchangedLedger(path: string, expected: Stats): void {
  const named = lstatSync(path);
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.dev !== expected.dev || named.ino !== expected.ino
    || named.size !== expected.size || named.mtimeMs !== expected.mtimeMs || named.mode !== expected.mode || named.uid !== expected.uid) throw new Error('Changing ledger');
}
/** Replace only validated history, under the same lock used by every appender. */
function compactLedger(path: string, expected: Stats, events: Event[], lock: NonNullable<ReturnType<typeof acquireLocalStoreLock>>): void {
  const bytes = encodeEvents(events);
  if (events.length > MAX_ROWS || bytes.length > MAX_BYTES) throw new Error('Live ledger limit');
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    created = true;
    const opened = privateFile(fd);
    writeAll(fd, bytes);
    fsyncSync(fd);
    const named = lstatSync(temporary);
    if (named.isSymbolicLink() || named.dev !== opened.dev || named.ino !== opened.ino || privateFile(fd).size !== bytes.length) throw new Error('Changing compacted ledger');
    closeSync(fd); fd = undefined;
    requireUnchangedLedger(path, expected);
    if (!ownsLocalStoreLock(lock)) throw new Error('Lost ledger lock');
    renameSync(temporary, path);
    created = false;
    fsyncDirectory(dirname(path));
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (created) unlinkSync(temporary);
  }
}
function cleanClaim(claim: OwnedClaim): FleetClaim {
  return { id: scrubSecrets(claim.id), repo: scrubSecrets(claim.repo), task: scrubSecrets(claim.task), agent: scrubSecrets(claim.agent), claimedAt: claim.claimedAt, expiresAt: claim.expiresAt };
}
export function readFleetBoard(options: FleetCoordinationOptions = {}): FleetBoard {
  const now = options.now ?? Date.now();
  try {
    const state = replay(readEvents(options.path ?? fleetCoordinationPath()).events);
    const claims = [...state.claims.values()];
    return { schema: 'fleet.coordination.v1', state: 'known', claims: claims.filter(c => c.expiresAt > now).map(cleanClaim),
      messages: state.messages.filter(m => m.expiresAt > now).map(m => ({ ...m, id: scrubSecrets(m.id), from: scrubSecrets(m.from), to: scrubSecrets(m.to), body: scrubSecrets(m.body) })),
      proposals: state.proposals.filter(p => p.expiresAt > now).map(p => ({ ...p, id: scrubSecrets(p.id), repo: scrubSecrets(p.repo), task: scrubSecrets(p.task), to: scrubSecrets(p.to) })),
      expiredClaims: claims.filter(c => c.expiresAt <= now).length };
  } catch { return { schema: 'fleet.coordination.v1', state: 'unknown', claims: [], messages: [], proposals: [], expiredClaims: null }; }
}
function mutate<T>(options: FleetCoordinationOptions, operation: (state: State, now: number) => FleetCoordinationResult<{ event: Event; value: T }>): FleetCoordinationResult<T> {
  const path = resolve(options.path ?? fleetCoordinationPath());
  const now = options.now ?? Date.now();
  let lock: ReturnType<typeof acquireLocalStoreLock> = null;
  let fd: number | undefined;
  try {
    if (!timestamp(now) || now > Number.MAX_SAFE_INTEGER - MAX_TTL_MS) return { ok: false, error: 'invalid-input' };
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    lock = acquireLocalStoreLock(`${path}.lock`, 2000);
    if (!lock) return { ok: false, error: 'unavailable' };
    const ledger = readEvents(path, true);
    const state = replay(ledger.events);
    const reaped: Event[] = [];
    for (const claim of state.claims.values()) if (claim.expiresAt <= now) { state.claims.delete(claim.id); reaped.push({ version: 1, kind: 'reap', at: now, id: claim.id }); }
    state.messages = state.messages.filter(message => message.expiresAt > now);
    state.proposals = state.proposals.filter(proposal => proposal.expiresAt > now);
    const result = operation(state, now);
    if (!result.ok) return result;
    const bytes = encodeEvents([...reaped, result.value.event]);
    if (!ownsLocalStoreLock(lock)) return { ok: false, error: 'unavailable' };
    if (ledger.stat && (ledger.events.length + reaped.length + 1 >= MAX_ROWS * 0.8 || ledger.stat.size + bytes.length >= MAX_BYTES * 0.8)) {
      // Replay the mutation too: releases and handoffs can free capacity even
      // when all remaining history was live. Expired data never survives compaction.
      compactLedger(path, ledger.stat, stateEvents(replay([...stateEvents(state), result.value.event])), lock);
      return { ok: true, value: result.value.value };
    }
    if (ledger.events.length + reaped.length + 1 > MAX_ROWS) return { ok: false, error: 'unavailable' };
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    const stat = privateFile(fd);
    if (ledger.stat) {
      requireUnchangedLedger(path, ledger.stat);
      if (stat.ino !== ledger.stat.ino || stat.dev !== ledger.stat.dev) throw new Error('Changing ledger');
    } else if (stat.size !== 0) throw new Error('Changing ledger');
    if (stat.size + bytes.length > MAX_BYTES) return { ok: false, error: 'unavailable' };
    writeAll(fd, bytes);
    fsyncSync(fd);
    fsyncDirectory(dirname(path));
    return { ok: true, value: result.value.value };
  } catch { return { ok: false, error: 'unavailable' }; }
  finally { if (fd !== undefined) closeSync(fd); if (lock) releaseLocalStoreLock(lock); }
}
function ttlValid(ttl: number): boolean { return Number.isSafeInteger(ttl) && ttl > 0 && ttl <= MAX_TTL_MS; }
function workValid(repo: string, task: string, agent: string, ttl: number): boolean { return REPO.test(repo) && text(task) && ident(agent) && ttlValid(ttl); }
function workKey(repo: string, task: string): string { return `${repo.toLowerCase()}\n${task.trim().replace(/\s+/g, ' ').toLowerCase()}`; }
export function claimFleetWork(input: { repo: string; task: string; agent: string; ttlMs?: number }, options: FleetCoordinationOptions = {}): FleetCoordinationResult<{ claim: FleetClaim; lease: string }> {
  const ttl = input.ttlMs ?? FLEET_CLAIM_TTL_MS;
  if (!workValid(input.repo, input.task, input.agent, ttl)) return { ok: false, error: 'invalid-input' };
  return mutate(options, (state, now) => {
    if ([...state.claims.values()].some(c => workKey(c.repo, c.task) === workKey(input.repo, input.task))) return { ok: false, error: 'duplicate' };
    const lease = randomUUID();
    const claim: OwnedClaim = { id: randomUUID(), repo: input.repo, task: input.task.trim(), agent: input.agent, claimedAt: now, expiresAt: now + ttl, leaseHash: hash(lease) };
    return { ok: true, value: { event: { version: 1, kind: 'claim', at: now, claim }, value: { claim: cleanClaim(claim), lease } } };
  });
}
export function releaseFleetClaim(input: { id: string; agent: string; lease: string }, options: FleetCoordinationOptions = {}): FleetCoordinationResult<{ released: string }> {
  if (!ident(input.id) || !ident(input.agent) || !text(input.lease, 128)) return { ok: false, error: 'invalid-input' };
  return mutate(options, (state, now) => {
    const claim = state.claims.get(input.id);
    if (!claim) return { ok: false, error: 'not-found' };
    if (claim.agent !== input.agent || claim.leaseHash !== hash(input.lease)) return { ok: false, error: 'not-owner' };
    return { ok: true, value: { event: { version: 1, kind: 'release', at: now, id: claim.id }, value: { released: claim.id } } };
  });
}
export function handoffFleetClaim(input: { id: string; agent: string; lease: string; to: string; ttlMs?: number }, options: FleetCoordinationOptions = {}): FleetCoordinationResult<{ claim: FleetClaim; lease: string }> {
  const ttl = input.ttlMs ?? FLEET_CLAIM_TTL_MS;
  if (!ident(input.id) || !ident(input.agent) || !ident(input.to) || !text(input.lease, 128) || !ttlValid(ttl)) return { ok: false, error: 'invalid-input' };
  return mutate(options, (state, now) => {
    const old = state.claims.get(input.id);
    if (!old) return { ok: false, error: 'not-found' };
    if (old.agent !== input.agent || old.leaseHash !== hash(input.lease)) return { ok: false, error: 'not-owner' };
    const lease = randomUUID();
    const claim = { ...old, agent: input.to, claimedAt: now, expiresAt: now + ttl, leaseHash: hash(lease) };
    return { ok: true, value: { event: { version: 1, kind: 'handoff', at: now, claim }, value: { claim: cleanClaim(claim), lease } } };
  });
}
export function postFleetMessage(input: { from: string; to: string; body: string; ttlMs?: number; id?: string }, options: FleetCoordinationOptions = {}): FleetCoordinationResult<FleetMessage> {
  const ttl = input.ttlMs ?? FLEET_CLAIM_TTL_MS;
  if (!ident(input.from) || !ident(input.to) || !text(input.body, 4000) || !ttlValid(ttl) || (input.id !== undefined && !ident(input.id))) return { ok: false, error: 'invalid-input' };
  return mutate(options, (state, now) => {
    if (state.messages.some(m => m.id === input.id || (m.expiresAt > now && m.from === input.from && m.to === input.to && m.body === input.body))) return { ok: false, error: 'duplicate' };
    const message = { id: input.id ?? randomUUID(), from: input.from, to: input.to, body: input.body, at: now, expiresAt: now + ttl };
    return { ok: true, value: { event: { version: 1, kind: 'post', at: now, message }, value: message } };
  });
}
export function proposeFleetAssignment(input: { repo: string; task: string; to: string; ttlMs?: number }, options: FleetCoordinationOptions = {}): FleetCoordinationResult<FleetAssignment> {
  const ttl = input.ttlMs ?? FLEET_CLAIM_TTL_MS;
  if (!workValid(input.repo, input.task, input.to, ttl)) return { ok: false, error: 'invalid-input' };
  return mutate(options, (state, now) => {
    if (state.proposals.some(p => p.expiresAt > now && workKey(p.repo, p.task) === workKey(input.repo, input.task))) return { ok: false, error: 'duplicate' };
    const proposal: FleetAssignment = { id: randomUUID(), repo: input.repo, task: input.task, to: input.to, at: now, expiresAt: now + ttl, executionAuthorized: false };
    return { ok: true, value: { event: { version: 1, kind: 'assign', at: now, proposal }, value: proposal } };
  });
}
