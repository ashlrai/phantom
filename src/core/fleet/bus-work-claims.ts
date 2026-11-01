/** Local coordination only: labels and tokens confer no execution authority. */
import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { listBusInboxAfter, type BusInboxReceipt } from './bus-inbox.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from './local-store-lock.js';

export const CLAIM_MAX_ROWS = 1024, CLAIM_MAX_BYTES = 512 * 1024, CLAIM_MAX_LEASE_MS = 3_600_000;
type Action = 'acquire' | 'renew' | 'release' | 'complete';
export interface BusClaimRequest { action: Action; id: string; owner?: string; leaseMs?: number; token?: string; root?: string }
interface Row {
  id: string; cursor: number; receivedAt: number; ttl: number; token: string; owner: string;
  leaseMs: number; leaseUntil: number; completedAt: number | null;
}
export interface BusClaimResult { status: string; token?: string; leaseUntil?: number }
const label = (s: unknown): s is string => typeof s === 'string' && /^[\x21-\x7e]{1,128}(?![\s\S])/.test(s);
const token = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9]{64}(?![\s\S])/.test(s);
const integer = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;
export function validBusClaimRequest(r: BusClaimRequest): boolean {
  return ['acquire', 'renew', 'release', 'complete'].includes(r.action) && label(r.id) &&
    (r.root === undefined || (typeof r.root === 'string' && isAbsolute(r.root) && !r.root.includes('\0'))) &&
    (r.action === 'acquire' ? label(r.owner) && integer(r.leaseMs) && r.leaseMs > 0 &&
      r.leaseMs <= CLAIM_MAX_LEASE_MS && r.token === undefined
      : token(r.token) && r.owner === undefined && r.leaseMs === undefined);
}
function privatePath(path: string, kind: 'file' | 'directory', root: string): void {
  const s = lstatSync(path);
  if (s.isSymbolicLink() || (kind === 'file' ? !s.isFile() || s.nlink !== 1 : !s.isDirectory()) ||
    (typeof process.getuid === 'function' && s.uid !== process.getuid()) ||
    (process.platform !== 'win32' && (s.mode & 0o7777) !== (kind === 'file' ? 0o600 : 0o700)) ||
    !assurePrivateStoragePath(path, kind, 'inspect-existing', { anchorPath: root }).ok) throw new Error('Unavailable');
}
function load(file: string, root: string): Row[] {
  try { privatePath(file, 'file', root); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
  const read = readStableRegularFile(file, { anchorPath: root, maxFileBytes: CLAIM_MAX_BYTES, remainingBytes: CLAIM_MAX_BYTES });
  if (!read.ok) throw new Error('Unavailable');
  const rows: Row[] = JSON.parse(read.text);
  if (!Array.isArray(rows) || rows.length > CLAIM_MAX_ROWS) throw new Error('Unavailable');
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r || Object.keys(r).sort().join() !== 'completedAt,cursor,id,leaseMs,leaseUntil,owner,receivedAt,token,ttl' ||
      !label(r.id) || !label(r.owner) || !token(r.token) || !integer(r.cursor) || r.cursor < 1 ||
      !integer(r.receivedAt) || !integer(r.ttl) || r.ttl < 1 || !integer(r.leaseMs) || r.leaseMs < 1 ||
      r.leaseMs > CLAIM_MAX_LEASE_MS || !integer(r.leaseUntil) || r.leaseUntil < r.receivedAt ||
      r.leaseUntil - r.receivedAt > r.ttl ||
      (r.completedAt !== null && (!integer(r.completedAt) || r.completedAt < r.receivedAt || r.completedAt >= r.leaseUntil))) throw new Error('Unavailable');
    const key = JSON.stringify([r.id, r.cursor, r.receivedAt]);
    if (seen.has(key)) throw new Error('Unavailable');
    seen.add(key);
  }
  return rows;
}
function receipt(id: string, root: string): BusInboxReceipt | undefined {
  // At zero, the reader returns original TTL, including expired retained receipts.
  let after = 0;
  for (let page = 0; page < 11; page++) {
    const result = listBusInboxAfter(after, 100, { root, now: () => 0 });
    if (result.status !== 'ok') throw new Error('Unavailable');
    const found = result.messages.find(r => r.envelope.id === id);
    if (found) return found;
    if (result.nextCursor === after) return undefined;
    after = result.nextCursor;
  }
  throw new Error('Unavailable');
}
export function mutateBusWorkClaim(request: BusClaimRequest): BusClaimResult {
  if (!validBusClaimRequest(request)) return { status: 'invalid' };
  try {
    const root = request.root ?? join(ashlrHome(), 'fleet');
    // The inbox must already exist; invalid/missing messages never create a root.
    const first = receipt(request.id, root);
    if (!first) return { status: 'missing' };
    const directory = join(root, 'bus-work-claims'), file = join(directory, 'claims.json');
    privatePath(root, 'directory', root);
    try { mkdirSync(directory, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    privatePath(directory, 'directory', root);
    const lock = acquireLocalStoreLockWithOutcome(join(directory, 'writer.lock'), 0, { anchorPath: root, exactPrivateStorage: true });
    if (lock.state !== 'acquired') return { status: lock.state === 'contended' ? 'retryable' : 'unavailable' };
    try {
      const rows = load(file, root), current = receipt(request.id, root), now = Date.now();
      if (!current) return { status: 'lost' };
      const { cursor, receivedAt, envelope } = current;
      if (!integer(now) || now < receivedAt) return { status: 'invalid' };
      const remaining = envelope.ttl - (now - receivedAt);
      const row = rows.find(r => r.id === request.id && r.cursor === cursor && r.receivedAt === receivedAt);
      if (row && row.ttl !== envelope.ttl) return { status: 'lost' };
      if (remaining <= 0) return { status: 'expired' };
      if (row?.completedAt !== null && row?.completedAt !== undefined) return { status: 'completed' };
      let result: BusClaimResult;
      if (request.action === 'acquire') {
        if (row && row.leaseUntil > now) return { status: 'conflict' };
        const leaseMs = request.leaseMs!, leaseUntil = now + Math.min(leaseMs, remaining);
        if (!Number.isSafeInteger(leaseUntil)) return { status: 'invalid' };
        const next: Row = { id: request.id, cursor, receivedAt, ttl: envelope.ttl, token: randomBytes(32).toString('hex'),
          owner: request.owner!, leaseMs, leaseUntil, completedAt: null };
        if (row) rows[rows.indexOf(row)] = next; else rows.push(next);
        result = { status: 'acquired', token: next.token, leaseUntil };
      } else {
        if (!row) return { status: 'lost' };
        if (row.token !== request.token) return { status: 'mismatched-token' };
        if (row.leaseUntil <= now) return { status: 'expired' };
        if (request.action === 'release') rows.splice(rows.indexOf(row), 1);
        if (request.action === 'complete') row.completedAt = now;
        if (request.action === 'renew') row.leaseUntil = now + Math.min(row.leaseMs, remaining);
        result = { status: request.action === 'renew' ? 'renewed' : request.action === 'release' ? 'released' : 'completed', leaseUntil: row.leaseUntil };
      }
      const json = JSON.stringify(rows);
      if (rows.length > CLAIM_MAX_ROWS || Buffer.byteLength(json) > CLAIM_MAX_BYTES) return { status: 'full' };
      const pending = join(directory, '.pending');
      // With the writer lock held, a leftover stage belongs to a vanished writer.
      // Canonical state was validated above; an incomplete stage is never promoted.
      try { privatePath(pending, 'file', root); unlinkSync(pending); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      writePrivateFileAtomically(pending, file, json, { anchorPath: root, label: 'Bus claims' });
      return result;
    } finally { releaseLocalStoreLock(lock.lock); }
  } catch { return { status: 'unavailable' }; }
}
