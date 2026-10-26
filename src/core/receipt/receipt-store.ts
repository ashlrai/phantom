/**
 * receipt.v1 local store (slice R3): sign and write one receipt per run, read
 * and verify it back. Files live at ~/.ashlr/receipts/<run_id>.json (0600,
 * directory 0700). A receipt is written once; an existing file is never
 * overwritten (amendments arrive later as signed `later[]` entries).
 */
import { closeSync, constants as fsc, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadReceiptPublicKeyReadOnly, loadReceiptSigningKey } from './receipt-key.js';
import {
  MAX_LATER_ENTRIES, normalizeLaterData, RECEIPT_LATER_SCHEMA, signReceiptLater, verifyReceiptLaterChain,
  type LaterDataByKind, type ReceiptLaterEntry, type ReceiptLaterFailure, type ReceiptLaterKind,
} from './receipt-later.js';
import { signReceiptV1, verifyReceiptV1, type ReceiptV1, type ReceiptV1Body, type ReceiptV1Failure } from './receipt-v1.js';

const RUN_ID = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_RECEIPT_BYTES = 256 * 1024;

export function receiptsDir(): string {
  return join(homedir(), '.ashlr', 'receipts');
}

function receiptPath(runId: string): string | null {
  if (!RUN_ID.test(runId) || runId === '.' || runId === '..') return null;
  return join(receiptsDir(), `${runId}.json`);
}

export type EmitReceiptResult =
  | { ok: true; path: string; keyId: string; digestPrefix: string }
  | { ok: false; reason: 'body-invalid' | 'no-signing-key' | 'exists' | 'write-failed' };

/** Sign and write a receipt. Never throws and never overwrites. */
export function emitReceiptV1(body: ReceiptV1Body): EmitReceiptResult {
  const path = receiptPath(body.run_id);
  if (!path) return { ok: false, reason: 'body-invalid' };
  const key = loadReceiptSigningKey();
  if (!key) return { ok: false, reason: 'no-signing-key' };
  const signed = signReceiptV1(body, key.privateKey, key.publicKey);
  if (!signed) return { ok: false, reason: 'body-invalid' };
  const verdict = verifyReceiptV1(signed, key.publicKey);
  if (!verdict.ok) return { ok: false, reason: 'body-invalid' };
  let fd: number | undefined;
  try {
    mkdirSync(receiptsDir(), { recursive: true, mode: 0o700 });
    fd = openSync(path, 'wx', 0o600);
    writeSync(fd, `${JSON.stringify(signed, null, 2)}\n`);
    return { ok: true, path, keyId: key.keyId, digestPrefix: verdict.digest.slice(0, 12) };
  } catch (error) {
    return { ok: false, reason: (error as NodeJS.ErrnoException)?.code === 'EEXIST' ? 'exists' : 'write-failed' };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export type ReadReceiptResult =
  | { ok: true; receipt: ReceiptV1; digest: string; later?: ReceiptLaterEntry[] }
  | { ok: false; reason: 'run-id-invalid' | 'missing' | 'unreadable' | 'no-public-key' | 'later-unreadable' | ReceiptV1Failure | ReceiptLaterFailure };

const MAX_LATER_BYTES = 8 * 1024;
const LATER_FILE = /^(\d{2})\.json$/;
const TMP_PREFIX = '.tmp-';

function laterDir(runId: string): string { return join(receiptsDir(), `${runId}.later`); }
const ownedByMe = (uid: number): boolean => typeof process.getuid !== 'function' || uid === process.getuid();

/** Read later[] files in seq order. Fails closed on symlinks, foreign owners, odd names, gaps or oversize files. */
function readLaterFiles(runId: string): { ok: true; entries: unknown[] } | { ok: false } {
  const dir = laterDir(runId);
  let st;
  try { st = lstatSync(dir); } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? { ok: true, entries: [] } : { ok: false };
  }
  if (!st.isDirectory() || st.isSymbolicLink() || !ownedByMe(st.uid)) return { ok: false };
  try {
    const names = readdirSync(dir).filter((n) => !n.startsWith(TMP_PREFIX)).sort();
    if (names.length > MAX_LATER_ENTRIES) return { ok: false };
    const entries: unknown[] = [];
    for (let i = 0; i < names.length; i++) {
      const m = LATER_FILE.exec(names[i]!);
      if (!m || Number(m[1]) !== i) return { ok: false };
      const f = join(dir, names[i]!);
      const fst = lstatSync(f);
      if (!fst.isFile() || fst.isSymbolicLink() || !ownedByMe(fst.uid) || fst.size > MAX_LATER_BYTES) return { ok: false };
      const fd = openSync(f, fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0));
      try { entries.push(JSON.parse(readFileSync(fd, 'utf8'))); } finally { closeSync(fd); }
    }
    return { ok: true, entries };
  } catch {
    return { ok: false };
  }
}

/** Read and verify one receipt and its later[] chain against this host's receipt key. Never throws. */
export function readReceiptV1(runId: string): ReadReceiptResult {
  const path = receiptPath(runId);
  if (!path) return { ok: false, reason: 'run-id-invalid' };
  let parsed: unknown;
  try {
    if (statSync(path).size > MAX_RECEIPT_BYTES) return { ok: false, reason: 'unreadable' };
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return { ok: false, reason: (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  const pub = loadReceiptPublicKeyReadOnly();
  if (!pub) return { ok: false, reason: 'no-public-key' };
  const v = verifyReceiptV1(parsed, pub.publicKey);
  if (!v.ok) return { ok: false, reason: v.reason };
  const files = readLaterFiles(runId);
  if (!files.ok) return { ok: false, reason: 'later-unreadable' };
  const chain = verifyReceiptLaterChain(runId, v.digest, files.entries, pub.publicKey);
  if (!chain.ok) return { ok: false, reason: chain.reason };
  return { ok: true, receipt: parsed as ReceiptV1, digest: v.digest, later: files.entries as ReceiptLaterEntry[] };
}

export type AppendLaterResult =
  | { ok: true; seq: number; digestPrefix: string }
  | { ok: false; reason: 'receipt-not-verified' | 'no-signing-key' | 'full' | 'conflict' | 'body-invalid' | 'write-failed' };

/**
 * Append one signed later[] entry (ci, merge, survival, revert). The receipt
 * and its existing chain must verify first. Unknown values become null. The
 * write is atomic and write-once: a 0600 temp file is fsynced, then hard-linked
 * to <seq>.json (EEXIST means a concurrent append won; nothing is overwritten).
 * Never throws.
 */
export function appendReceiptLater<K extends ReceiptLaterKind>(
  runId: string,
  kind: K,
  data: Partial<Record<keyof LaterDataByKind[K] & string, unknown>>,
  now: Date = new Date(),
): AppendLaterResult {
  let tmp: string | undefined;
  try {
    const r = readReceiptV1(runId);
    if (!r.ok) return { ok: false, reason: 'receipt-not-verified' };
    const later = r.later ?? [];
    if (later.length >= MAX_LATER_ENTRIES) return { ok: false, reason: 'full' };
    const key = loadReceiptSigningKey();
    if (!key) return { ok: false, reason: 'no-signing-key' };
    const pub = loadReceiptPublicKeyReadOnly();
    const head = pub ? verifyReceiptLaterChain(runId, r.digest, later, pub.publicKey) : null;
    if (!head || !head.ok) return { ok: false, reason: 'receipt-not-verified' };
    const entry = signReceiptLater({
      schema: RECEIPT_LATER_SCHEMA, run_id: runId, seq: later.length, kind, at: now.toISOString(), parent: head.head,
      data: normalizeLaterData(kind, data as Record<string, unknown>),
    }, key.privateKey, key.publicKey);
    if (!entry) return { ok: false, reason: 'body-invalid' };
    const text = `${JSON.stringify(entry, null, 2)}\n`;
    if (Buffer.byteLength(text) > MAX_LATER_BYTES) return { ok: false, reason: 'body-invalid' };
    const dir = laterDir(runId);
    try { mkdirSync(dir, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error; }
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink() || !ownedByMe(st.uid)) return { ok: false, reason: 'write-failed' };
    tmp = join(dir, `${TMP_PREFIX}${process.pid}-${randomBytes(6).toString('hex')}`);
    const fd = openSync(tmp, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | (fsc.O_NOFOLLOW ?? 0), 0o600);
    try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    try {
      linkSync(tmp, join(dir, `${String(entry.seq).padStart(2, '0')}.json`));
    } catch (error) {
      return { ok: false, reason: (error as NodeJS.ErrnoException)?.code === 'EEXIST' ? 'conflict' : 'write-failed' };
    }
    const digest = verifyReceiptLaterChain(runId, r.digest, [...later, entry], key.publicKey);
    return { ok: true, seq: entry.seq, digestPrefix: digest.ok ? digest.head.slice(0, 12) : '' };
  } catch {
    return { ok: false, reason: 'write-failed' };
  } finally {
    if (tmp) { try { unlinkSync(tmp); } catch { /* already gone */ } }
  }
}

/** Run ids with a receipt file, newest first by mtime, capped. */
export function listReceiptRunIds(limit = 50): string[] {
  try {
    return readdirSync(receiptsDir())
      .filter((f) => f.endsWith('.json') && RUN_ID.test(f.slice(0, -5)))
      .map((f) => ({ id: f.slice(0, -5), t: statSync(join(receiptsDir(), f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(0, Math.max(0, limit))
      .map((x) => x.id);
  } catch {
    return [];
  }
}

export interface ReceiptStatus { keyPresent: boolean; keyId: string | null; receipts: number; latest: { runId: string; verified: boolean; reason: string | null } | null }

/** Value-free status for `fleet receipt status` and doctor. Read-only. */
export function receiptStatus(): ReceiptStatus {
  const pub = loadReceiptPublicKeyReadOnly();
  const ids = listReceiptRunIds(10_000);
  const latestId = ids[0];
  let latest: ReceiptStatus['latest'] = null;
  if (latestId) {
    const r = readReceiptV1(latestId);
    latest = { runId: latestId, verified: r.ok, reason: r.ok ? null : r.reason };
  }
  return { keyPresent: pub !== null, keyId: pub?.keyId ?? null, receipts: ids.length, latest };
}
