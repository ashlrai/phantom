/**
 * Fleet custody ledger (design-custody-fleet.md 3.3, fleet slice C1).
 *
 * Append-only JSONL at ~/.ashlr/custody/spawns.jsonl: one value-free line per
 * phantom-enabled engine spawn, including every fleet worktree spawn. A line
 * is the custody record plus a timestamp. No paths, secret names, values or
 * error strings. Writes are best effort and never block or fail a spawn.
 * The file is capped; past the cap it rotates once to spawns.jsonl.1.
 *
 * Hardening: the ledger and its directory must be real (not symlinks), the
 * file is opened with O_NOFOLLOW and checked to be a regular file before any
 * write or read, fields are re-validated at write time (engine shape, integer
 * exit code, known reason), and reads are size-bounded.
 */
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { normalizeUnwrappedReason, type PhantomCustodyRecord, type UnwrappedReason } from './phantom-custody.js';

export const CUSTODY_LEDGER_SCHEMA = 1 as const;
export const CUSTODY_LEDGER_MAX_BYTES = 4 * 1024 * 1024;
/** Reads refuse a file larger than this (cap plus one record of slack, doubled). */
export const CUSTODY_LEDGER_MAX_READ_BYTES = 2 * CUSTODY_LEDGER_MAX_BYTES;

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const ENGINE_SHAPE = /^[A-Za-z0-9._-]{1,64}$/;

function custodyDir(): string {
  return join(homedir(), '.ashlr', 'custody');
}

/** The custody dir exists as a real directory (not a symlink). */
function ensureRealDir(dir: string): boolean {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  return st.isDirectory() && !st.isSymbolicLink();
}

function safeExit(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= -1 && v <= 255 ? v : null;
}

export function custodyLedgerPath(): string {
  return join(homedir(), '.ashlr', 'custody', 'spawns.jsonl');
}

/** Append one record. Never throws. Skips the write when the ledger or its dir is not a real file/dir. */
export function appendCustodyRecord(record: PhantomCustodyRecord, now: Date = new Date()): void {
  try {
    const dir = custodyDir();
    if (!ensureRealDir(dir)) return;
    const path = custodyLedgerPath();
    try {
      const st = lstatSync(path);
      if (!st.isFile()) return;
      if (st.size >= CUSTODY_LEDGER_MAX_BYTES) renameSync(path, `${path}.1`);
    } catch { /* absent: first write */ }
    const engine = typeof record.engine === 'string' && ENGINE_SHAPE.test(record.engine) ? record.engine : 'unknown';
    const preflight_exit = safeExit(record.preflight_exit);
    const line = record.wrapped === true
      ? { schema: CUSTODY_LEDGER_SCHEMA, at: now.toISOString(), wrapped: true, engine, preflight_exit }
      : { schema: CUSTODY_LEDGER_SCHEMA, at: now.toISOString(), wrapped: false, reason: normalizeUnwrappedReason(record.reason), engine, preflight_exit };
    const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | O_NOFOLLOW, 0o600);
    try {
      if (!fstatSync(fd).isFile()) return;
      writeSync(fd, `${JSON.stringify(line)}\n`);
    } finally {
      closeSync(fd);
    }
  } catch { /* best effort */ }
}

/** Read the ledger text: regular file only, no symlink, size-bounded. Null when absent or refused. */
function readLedgerText(): { text: string } | { refused: true } | null {
  let fd: number;
  try {
    fd = openSync(custodyLedgerPath(), constants.O_RDONLY | O_NOFOLLOW);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : { refused: true };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > CUSTODY_LEDGER_MAX_READ_BYTES) return { refused: true };
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    return { text: buf.subarray(0, off).toString('utf8') };
  } catch {
    return { refused: true };
  } finally {
    closeSync(fd);
  }
}

export interface CustodySummary {
  spawns: number;
  wrapped: number;
  unwrapped: Partial<Record<UnwrappedReason, number>>;
  malformed: number;
}

/** Count records at or after `since` (current file only). Never throws; a missing file is all zeros; a refused file (symlink, not regular, oversized) counts as one malformed. */
export function readCustodySummary(since: Date | null, text?: string): CustodySummary {
  const out: CustodySummary = { spawns: 0, wrapped: 0, unwrapped: {}, malformed: 0 };
  let body = text;
  if (body === undefined) {
    const r = readLedgerText();
    if (r === null) return out;
    if ('refused' in r) { out.malformed += 1; return out; }
    body = r.text;
  }
  const sinceMs = since ? since.getTime() : null;
  for (const raw of body.split('\n')) {
    if (raw.trim() === '') continue;
    let v: Record<string, unknown>;
    try { v = JSON.parse(raw) as Record<string, unknown>; } catch { out.malformed += 1; continue; }
    const at = typeof v['at'] === 'string' ? Date.parse(v['at']) : NaN;
    if (!v || v['schema'] !== CUSTODY_LEDGER_SCHEMA || Number.isNaN(at) || typeof v['wrapped'] !== 'boolean') { out.malformed += 1; continue; }
    if (sinceMs !== null && at < sinceMs) continue;
    out.spawns += 1;
    if (v['wrapped'] === true) { out.wrapped += 1; continue; }
    const reason = normalizeUnwrappedReason(v['reason']);
    out.unwrapped[reason] = (out.unwrapped[reason] ?? 0) + 1;
  }
  return out;
}
