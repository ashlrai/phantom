/**
 * Stigmergic coordination layer (docs/STIGMERGY.md): agents coordinate through
 * the environment, not messages. Each work item carries a private marker file
 * under `<ashlr home>/stigmergy/` recording its lease, heartbeat and resumable
 * checkpoint slot, so any agent can see live work and pick up where another
 * stalled. Claim keys reuse the Agent Bus v2 grammar and overlap rules;
 * markers coordinate and grant no execution authority.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { linkSync, lstatSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import {
  CLAIM_MAX_LEASE_MS, CLAIM_MIN_LEASE_MS, claimIsLive,
  findClaimConflict, parseClaimKey, type Claim,
} from './agents/bus-v2-schema.js';
import {
  AgentCheckpointError, readAgentCheckpoint, saveAgentCheckpoint, type AgentCheckpoint,
} from './agent-checkpoint.js';
import { assertMetadata } from './connectors/profile.js';
import { ashlrHome } from './cloud/store.js';
import {
  ensurePrivateDirectory, readPrivateFileCapped, writePrivateFileAtomic,
} from './verse/preferences.js';
import { fsyncDirectory } from './util/durability.js';

export const TRAIL_SCHEMA_VERSION = 1;
export const TRAIL_MAX_CLAIMS = 1024;
export const TRAIL_MAX_CLAIM_BYTES = 64 * 1024;
export const TRAIL_MAX_NOTE = 1024;
export const TRAIL_DEFAULT_LEASE_MS = 600_000;
/** Orphaned checkpoint slots are swept once their mtime passes this age. */
export const TRAIL_CHECKPOINT_MAX_AGE_MS = 7 * 24 * 3_600_000;

export class TrailError extends Error {
  constructor(message: string, readonly code: 'invalid' | 'unreadable' | 'io') { super(message); }
}

const labelPattern = /^[\x21-\x7e]{1,128}$/;
const tokenPattern = /^[a-f0-9]{64}$/;

const RECORD_REQUIRED = ['version', 'claimKey', 'owner', 'tokenHash', 'leaseMs', 'leaseUntil', 'heartbeatAt', 'createdAt', 'updatedAt'];
const RECORD_OPTIONAL = ['jobId', 'note', 'worktree'];

/** One marker file per claim key. The token stays with the claimant; the file holds only its SHA-256. */
export interface TrailClaimRecord {
  version: 1;
  claimKey: string;
  owner: string;
  jobId?: string;
  tokenHash: string;
  leaseMs: number;
  leaseUntil: number;
  heartbeatAt: number;
  note?: string;
  worktree?: string;
  createdAt: number;
  updatedAt: number;
}

/** What any agent may read from a marker; tokenHash and the token never appear. */
export interface TrailClaimView {
  claimKey: string;
  owner: string;
  jobId?: string;
  status: 'live' | 'expired';
  leaseMs: number;
  leaseUntil: number;
  leaseRemainingMs: number;
  heartbeatAt: number;
  heartbeatAgeMs: number;
  note?: string;
  worktree?: string;
  checkpoint?: string;
  createdAt: number;
  updatedAt: number;
}

export type TrailAcquireResult =
  | { status: 'claimed'; token: string; claim: TrailClaimView }
  | { status: 'conflict'; holder: TrailClaimView };

export type TrailRefusal = 'unknown-claim' | 'bad-token' | 'expired' | 'lost-race';
export type TrailMutateResult =
  | { status: 'ok'; claim: TrailClaimView }
  | { status: 'refused'; reason: TrailRefusal };

export interface TrailListResult { claims: TrailClaimView[]; unreadable: number }
export interface TrailSweepResult { removedClaims: number; removedCheckpoints: number; keptClaims: number }
export type TrailResumeResult =
  | { status: 'ok'; claim: TrailClaimView; checkpoint: AgentCheckpoint | null }
  | { status: 'refused'; reason: TrailRefusal };
export type TrailReleaseResult =
  | { status: 'released'; outcome: 'released' | 'completed'; claimKey: string }
  | { status: 'refused'; reason: TrailRefusal };
export type TrailSaveResult =
  | { status: 'saved'; claimKey: string; checkpoint: string }
  | { status: 'refused'; reason: TrailRefusal };

/** `<ashlr home>/stigmergy` or the caller-supplied root. */
export function trailDir(dir?: string): string {
  return dir ?? join(ashlrHome(), 'stigmergy');
}

function claimId(claimKey: string): string {
  return createHash('sha256').update(claimKey, 'utf8').digest('hex');
}
function claimFile(root: string, claimKey: string): string {
  return join(root, 'claims', `${claimId(claimKey)}.json`);
}
/** Deterministic per-key slot: the next claimant finds the saved state without a pointer. */
function checkpointFile(root: string, claimKey: string): string {
  return join(root, 'checkpoints', `${claimId(claimKey)}.json`);
}

function integer(n: unknown): n is number {
  return Number.isSafeInteger(n) && (n as number) >= 0;
}

function invalid(message: string): never {
  throw new TrailError(message, 'invalid');
}

function checkLabel(value: unknown, field: string): string {
  if (typeof value !== 'string' || !labelPattern.test(value)) invalid(`${field} must be printable ASCII, 1-128 chars.`);
  refuseSecrets(value);
  return value;
}

function checkNote(note: unknown): string | undefined {
  if (note === undefined) return undefined;
  if (typeof note !== 'string' || note.trim() === '' || note.length > TRAIL_MAX_NOTE) {
    invalid(`note must be a nonempty string of at most ${TRAIL_MAX_NOTE} chars.`);
  }
  refuseSecrets(note);
  return note;
}

function checkWorktree(worktree: unknown): string | undefined {
  if (worktree === undefined) return undefined;
  if (typeof worktree !== 'string' || !isAbsolute(worktree) || worktree.includes('\0')) {
    invalid('worktree must be an absolute path without NUL.');
  }
  refuseSecrets(worktree);
  return worktree;
}

function refuseSecrets(text: string): void {
  try { assertMetadata(text); } catch {
    invalid('Secret-shaped claim content refused; use secret references only.');
  }
}

function checkLeaseMs(leaseMs: unknown): number | undefined {
  if (leaseMs === undefined) return undefined;
  if (!integer(leaseMs) || leaseMs < CLAIM_MIN_LEASE_MS || leaseMs > CLAIM_MAX_LEASE_MS) {
    invalid(`leaseMs must be ${CLAIM_MIN_LEASE_MS}-${CLAIM_MAX_LEASE_MS}.`);
  }
  return leaseMs;
}

function checkToken(token: unknown): string {
  if (typeof token !== 'string' || !tokenPattern.test(token)) invalid('token must be 64 lowercase hex chars.');
  return token;
}

function checkClaimKey(claimKey: unknown): string {
  if (typeof claimKey !== 'string' || parseClaimKey(claimKey) === undefined) {
    invalid('claimKey must match the Agent Bus v2 grammar: repo:, path:, queue: or pr:.');
  }
  refuseSecrets(claimKey);
  return claimKey;
}

/** Strictly validate a marker; never discard or repair fields. */
export function parseTrailClaim(raw: string): TrailClaimRecord {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new TrailError('Claim marker is not valid JSON.', 'unreadable'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TrailError('Claim marker must be an object.', 'unreadable');
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!RECORD_REQUIRED.includes(key) && !RECORD_OPTIONAL.includes(key)) {
      throw new TrailError(`Claim marker has unknown field ${key}.`, 'unreadable');
    }
  }
  for (const key of RECORD_REQUIRED) {
    if (!Object.hasOwn(record, key)) throw new TrailError(`Claim marker is missing ${key}.`, 'unreadable');
  }
  const valid = record.version === TRAIL_SCHEMA_VERSION
    && typeof record.tokenHash === 'string' && /^[a-f0-9]{64}$/.test(record.tokenHash)
    && integer(record.leaseMs) && (record.leaseMs as number) >= CLAIM_MIN_LEASE_MS && (record.leaseMs as number) <= CLAIM_MAX_LEASE_MS
    && integer(record.leaseUntil) && integer(record.heartbeatAt) && integer(record.createdAt) && integer(record.updatedAt);
  if (!valid) throw new TrailError('Claim marker fields failed validation.', 'unreadable');
  try {
    checkClaimKey(record.claimKey);
    checkLabel(record.owner, 'owner');
    if (record.jobId !== undefined) checkLabel(record.jobId, 'jobId');
    checkNote(record.note);
    checkWorktree(record.worktree);
  } catch {
    throw new TrailError('Claim marker fields failed validation.', 'unreadable');
  }
  return value as TrailClaimRecord;
}

type ReadOutcome = { kind: 'missing' } | { kind: 'record'; record: TrailClaimRecord } | { kind: 'corrupt' };

function readClaimFile(path: string): ReadOutcome {
  const read = readPrivateFileCapped(path, TRAIL_MAX_CLAIM_BYTES);
  if (read === null || read.truncated) {
    let exists = false;
    try { exists = lstatSync(path).isFile(); } catch { exists = false; }
    return exists ? { kind: 'corrupt' } : { kind: 'missing' };
  }
  try {
    return { kind: 'record', record: parseTrailClaim(read.text) };
  } catch {
    return { kind: 'corrupt' };
  }
}

function ensureTrailDirs(root: string): void {
  ensurePrivateDirectory(root);
  ensurePrivateDirectory(join(root, 'claims'));
  ensurePrivateDirectory(join(root, 'checkpoints'));
}

/** List claim records without creating anything; corrupt files count as unreadable. */
function scanClaims(root: string): { records: TrailClaimRecord[]; unreadable: number } {
  let names: string[];
  try {
    names = readdirSync(join(root, 'claims')).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
  } catch {
    return { records: [], unreadable: 0 };
  }
  const records: TrailClaimRecord[] = [];
  let unreadable = 0;
  for (const name of names.slice(0, TRAIL_MAX_CLAIMS)) {
    const outcome = readClaimFile(join(root, 'claims', name));
    if (outcome.kind === 'record') records.push(outcome.record);
    else if (outcome.kind === 'corrupt') unreadable++;
  }
  return { records, unreadable };
}

function publicView(root: string, record: TrailClaimRecord, now: number): TrailClaimView {
  const slot = checkpointFile(root, record.claimKey);
  let hasCheckpoint = false;
  try { hasCheckpoint = lstatSync(slot).isFile(); } catch { hasCheckpoint = false; }
  const view: TrailClaimView = {
    claimKey: record.claimKey,
    owner: record.owner,
    status: claimIsLive({ leaseUntil: record.leaseUntil }, now) ? 'live' : 'expired',
    leaseMs: record.leaseMs,
    leaseUntil: record.leaseUntil,
    leaseRemainingMs: Math.max(0, record.leaseUntil - now),
    heartbeatAt: record.heartbeatAt,
    heartbeatAgeMs: Math.max(0, now - record.heartbeatAt),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  if (record.jobId !== undefined) view.jobId = record.jobId;
  if (record.note !== undefined) view.note = record.note;
  if (record.worktree !== undefined) view.worktree = record.worktree;
  if (hasCheckpoint) view.checkpoint = slot;
  return view;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function tokenMatches(record: TrailClaimRecord, presented: string): boolean {
  const expected = Buffer.from(record.tokenHash, 'utf8');
  const actual = Buffer.from(tokenHash(presented), 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function serialize(record: TrailClaimRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/** Publish a marker via create-exclusive temp + hard link: at most one claimant wins the name. */
function createClaimFile(path: string, record: TrailClaimRecord): 'created' | 'exists' {
  const temp = join(dirname(path), `.claim-${process.pid}-${randomBytes(8).toString('hex')}.tmp`);
  writePrivateFileAtomic(temp, serialize(record));
  try {
    linkSync(temp, path);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* best effort */ }
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
    throw new TrailError('Cannot publish claim marker.', 'io');
  }
  try { unlinkSync(temp); } catch { /* best effort */ }
  try { fsyncDirectory(dirname(path)); } catch { /* durability is best effort */ }
  return 'created';
}

/** Overwrite a marker the holder still owns; refuse when the file no longer carries our token. */
function replaceClaimFile(path: string, record: TrailClaimRecord, expectedToken: string): boolean {
  writePrivateFileAtomic(path, serialize(record));
  const confirm = readClaimFile(path);
  return confirm.kind === 'record' && tokenMatches(confirm.record, expectedToken);
}

function refuse(reason: TrailRefusal): { status: 'refused'; reason: TrailRefusal } {
  return { status: 'refused', reason };
}

/** Acquire a claim key. A live overlapping marker yields a conflict; expired or corrupt markers evaporate. */
export function claimTrail(options: {
  claimKey: string; owner: string; jobId?: string; leaseMs?: number;
  note?: string; worktree?: string; dir?: string; now?: number;
}): TrailAcquireResult {
  const claimKey = checkClaimKey(options.claimKey);
  const owner = checkLabel(options.owner, 'owner');
  const jobId = options.jobId === undefined ? undefined : checkLabel(options.jobId, 'jobId');
  const note = checkNote(options.note);
  const worktree = checkWorktree(options.worktree);
  const leaseMs = options.leaseMs === undefined ? TRAIL_DEFAULT_LEASE_MS : checkLeaseMs(options.leaseMs)!;
  const root = trailDir(options.dir);
  const now = options.now ?? Date.now();
  ensureTrailDirs(root);

  const { records } = scanClaims(root);
  const claims: Claim[] = records.map(r => ({
    claimKey: r.claimKey, owner: r.owner, leaseMs: r.leaseMs, token: r.tokenHash, leaseUntil: r.leaseUntil,
  }));
  const conflict = findClaimConflict(claims, claimKey, now);
  if (conflict) {
    const holder = records.find(r => r.claimKey === conflict.claimKey)!;
    return { status: 'conflict', holder: publicView(root, holder, now) };
  }

  const path = claimFile(root, claimKey);
  const existing = readClaimFile(path);
  if (existing.kind === 'record' && claimIsLive({ leaseUntil: existing.record.leaseUntil }, now)) {
    return { status: 'conflict', holder: publicView(root, existing.record, now) };
  }
  if (existing.kind !== 'missing') {
    try { unlinkSync(path); } catch { /* someone else removed it */ }
  }

  const token = randomBytes(32).toString('hex');
  const record: TrailClaimRecord = {
    version: TRAIL_SCHEMA_VERSION, claimKey, owner, tokenHash: tokenHash(token),
    leaseMs, leaseUntil: now + leaseMs, heartbeatAt: now, createdAt: now, updatedAt: now,
  };
  if (jobId !== undefined) record.jobId = jobId;
  if (note !== undefined) record.note = note;
  if (worktree !== undefined) record.worktree = worktree;

  for (let attempt = 0; attempt < 2; attempt++) {
    const outcome = createClaimFile(path, record);
    if (outcome === 'created') return { status: 'claimed', token, claim: publicView(root, record, now) };
    const raced = readClaimFile(path);
    if (raced.kind === 'record' && claimIsLive({ leaseUntil: raced.record.leaseUntil }, now)) {
      return { status: 'conflict', holder: publicView(root, raced.record, now) };
    }
    if (raced.kind !== 'missing') {
      try { unlinkSync(path); } catch { /* retry handles it */ }
    }
  }
  throw new TrailError('Cannot publish claim marker.', 'io');
}

/** Heartbeat: extend the lease and refresh the visible note; only the live token holder may beat. */
export function beatTrail(options: {
  claimKey: string; token: string; note?: string; leaseMs?: number; dir?: string; now?: number;
}): TrailMutateResult {
  const claimKey = checkClaimKey(options.claimKey);
  const token = checkToken(options.token);
  const note = checkNote(options.note);
  const root = trailDir(options.dir);
  const now = options.now ?? Date.now();
  const path = claimFile(root, claimKey);
  const outcome = readClaimFile(path);
  if (outcome.kind !== 'record') return refuse('unknown-claim');
  const record = outcome.record;
  if (!claimIsLive({ leaseUntil: record.leaseUntil }, now)) return refuse('expired');
  if (!tokenMatches(record, token)) return refuse('bad-token');
  const leaseMs = options.leaseMs === undefined ? record.leaseMs : checkLeaseMs(options.leaseMs)!;
  const next: TrailClaimRecord = {
    ...record, leaseMs, leaseUntil: now + leaseMs, heartbeatAt: now, updatedAt: now,
  };
  if (note !== undefined) next.note = note;
  if (!replaceClaimFile(path, next, token)) return refuse('lost-race');
  return { status: 'ok', claim: publicView(root, next, now) };
}

/** Release or complete a claim; the marker evaporates, the checkpoint slot survives for the next claimant. */
export function releaseTrail(options: {
  claimKey: string; token: string; outcome?: 'released' | 'completed'; dir?: string;
}): TrailReleaseResult {
  const claimKey = checkClaimKey(options.claimKey);
  const token = checkToken(options.token);
  const outcome = options.outcome ?? 'released';
  if (outcome !== 'released' && outcome !== 'completed') invalid("outcome must be 'released' or 'completed'.");
  const root = trailDir(options.dir);
  const path = claimFile(root, claimKey);
  const read = readClaimFile(path);
  if (read.kind !== 'record') return { status: 'refused', reason: 'unknown-claim' };
  if (!tokenMatches(read.record, token)) return { status: 'refused', reason: 'bad-token' };
  try {
    unlinkSync(path);
    try { fsyncDirectory(dirname(path)); } catch { /* best effort */ }
  } catch {
    throw new TrailError('Cannot remove claim marker.', 'io');
  }
  return { status: 'released', outcome, claimKey };
}

/**
 * Persist resumable partial state into the claim's checkpoint slot. With a
 * worktree, the authored handoff gains the current HEAD and porcelain status;
 * without one it is validated and stored as authored.
 */
export async function saveTrailCheckpoint(options: {
  claimKey: string; token: string; source: string; worktree?: string; dir?: string; now?: number;
}): Promise<TrailSaveResult> {
  const claimKey = checkClaimKey(options.claimKey);
  const token = checkToken(options.token);
  const worktree = checkWorktree(options.worktree);
  const root = trailDir(options.dir);
  const now = options.now ?? Date.now();
  const read = readClaimFile(claimFile(root, claimKey));
  if (read.kind !== 'record') return refuse('unknown-claim');
  if (!claimIsLive({ leaseUntil: read.record.leaseUntil }, now)) return refuse('expired');
  if (!tokenMatches(read.record, token)) return refuse('bad-token');
  const slot = checkpointFile(root, claimKey);
  ensurePrivateDirectory(join(root, 'checkpoints'));
  try {
    if (worktree !== undefined) {
      await saveAgentCheckpoint(options.source, slot, worktree);
    } else {
      const authored = await readAgentCheckpoint(options.source);
      writePrivateFileAtomic(slot, `${JSON.stringify(authored, null, 2)}\n`);
    }
  } catch (error) {
    if (error instanceof AgentCheckpointError) invalid(error.message);
    throw new TrailError('Cannot save checkpoint.', 'io');
  }
  const next: TrailClaimRecord = { ...read.record, updatedAt: now };
  if (!replaceClaimFile(claimFile(root, claimKey), next, token)) return refuse('lost-race');
  return { status: 'saved', claimKey, checkpoint: slot };
}

/** Read every marker; live claims sort ahead of expired ones, freshest heartbeat first. */
export function listTrailClaims(options: { dir?: string; now?: number } = {}): TrailListResult {
  const root = trailDir(options.dir);
  const now = options.now ?? Date.now();
  const { records, unreadable } = scanClaims(root);
  const views = records.map(r => publicView(root, r, now));
  views.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'live' ? -1 : 1;
    return b.heartbeatAt - a.heartbeatAt;
  });
  return { claims: views, unreadable };
}

/** One marker by key; undefined when absent or unreadable. */
export function showTrailClaim(options: { claimKey: string; dir?: string; now?: number }): TrailClaimView | undefined {
  const claimKey = checkClaimKey(options.claimKey);
  const root = trailDir(options.dir);
  const now = options.now ?? Date.now();
  const read = readClaimFile(claimFile(root, claimKey));
  return read.kind === 'record' ? publicView(root, read.record, now) : undefined;
}

/** Pick up where another agent stalled: the marker view plus the full saved checkpoint. */
export async function resumeTrail(options: { claimKey: string; dir?: string; now?: number }): Promise<TrailResumeResult> {
  const claimKey = checkClaimKey(options.claimKey);
  const root = trailDir(options.dir);
  const now = options.now ?? Date.now();
  const read = readClaimFile(claimFile(root, claimKey));
  if (read.kind !== 'record') return refuse('unknown-claim');
  const claim = publicView(root, read.record, now);
  let checkpoint: AgentCheckpoint | null = null;
  if (claim.checkpoint !== undefined) {
    try { checkpoint = await readAgentCheckpoint(claim.checkpoint); } catch { checkpoint = null; }
  }
  return { status: 'ok', claim, checkpoint };
}

/** Evaporate expired markers and orphaned checkpoint slots past their retention. */
export function sweepTrail(options: {
  dir?: string; now?: number; checkpointMaxAgeMs?: number;
} = {}): TrailSweepResult {
  const root = trailDir(options.dir);
  const now = options.now ?? Date.now();
  const maxAge = options.checkpointMaxAgeMs ?? TRAIL_CHECKPOINT_MAX_AGE_MS;
  if (!integer(maxAge) || maxAge < 1) invalid('checkpointMaxAgeMs must be a positive integer.');
  let removedClaims = 0, removedCheckpoints = 0, keptClaims = 0;
  const claimsDir = join(root, 'claims');
  let names: string[] = [];
  try { names = readdirSync(claimsDir); } catch { names = []; }
  const live = new Set<string>();
  for (const name of names) {
    const path = join(claimsDir, name);
    if (/^\.claim-.*\.tmp$/.test(name)) {
      try { unlinkSync(path); removedClaims++; } catch { /* already gone */ }
      continue;
    }
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const outcome = readClaimFile(path);
    if (outcome.kind === 'record' && claimIsLive({ leaseUntil: outcome.record.leaseUntil }, now)) {
      keptClaims++;
      live.add(name.slice(0, 64));
      continue;
    }
    try { unlinkSync(path); removedClaims++; } catch { /* already gone */ }
  }
  const checkpointsDir = join(root, 'checkpoints');
  let slots: string[] = [];
  try { slots = readdirSync(checkpointsDir); } catch { slots = []; }
  for (const name of slots) {
    const path = join(checkpointsDir, name);
    if (!/^\.?[a-z0-9._-]*\.tmp$/i.test(name) && !/^[a-f0-9]{64}\.json$/.test(name)) continue;
    let stat;
    try { stat = lstatSync(path); } catch { continue; }
    if (!stat.isFile()) continue;
    if (/\.tmp$/i.test(name) || (!live.has(name.slice(0, 64)) && now - stat.mtimeMs > maxAge)) {
      try { unlinkSync(path); removedCheckpoints++; } catch { /* already gone */ }
    }
  }
  return { removedClaims, removedCheckpoints, keptClaims };
}
