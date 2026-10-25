/**
 * receipt.v1 local store (slice R3): sign and write one receipt per run, read
 * and verify it back. Files live at ~/.ashlr/receipts/<run_id>.json (0600,
 * directory 0700). A receipt is written once; an existing file is never
 * overwritten (amendments arrive later as signed `later[]` entries).
 */
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadReceiptPublicKeyReadOnly, loadReceiptSigningKey } from './receipt-key.js';
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
  | { ok: true; receipt: ReceiptV1; digest: string }
  | { ok: false; reason: 'run-id-invalid' | 'missing' | 'unreadable' | 'no-public-key' | ReceiptV1Failure };

/** Read and verify one receipt against this host's receipt key. Never throws. */
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
  return v.ok ? { ok: true, receipt: parsed as ReceiptV1, digest: v.digest } : { ok: false, reason: v.reason };
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
