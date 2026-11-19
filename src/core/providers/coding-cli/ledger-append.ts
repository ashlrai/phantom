/**
 * Append-only writer for the recorded coding-pool spend ledger.
 *
 * Recovered from PR #5952 (head 3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886,
 * src/core/providers/coding-cli/ledger.ts appendSpendDecision). The source
 * appended with a bare appendFileSync; this version validates the whole row
 * before the file is opened, requires an existing regular non-symlink file,
 * refuses an unterminated last line, and respects the reader's byte ceiling.
 * It never creates files or parent directories and never rewrites earlier bytes.
 */

import { closeSync, constants, fstatSync, fsyncSync, openSync, readSync, writeSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { parseSpendDecision, SPEND_LEDGER_MAX_BYTES, type SpendDecision } from './ledger.js';

/** Ceiling on one encoded row; also the input ceiling for row files in the CLI. */
export const SPEND_ROW_MAX_BYTES = 64 * 1024;

/** Fixed, non-sensitive refusal text. Raw filesystem errors are never surfaced. */
export class SpendLedgerAppendError extends Error {}

const NOFOLLOW = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;

/**
 * Canonical single-line encoding of a row, validated by the source parser.
 * Throws before any filesystem access when the row is incomplete or unknown.
 * Null quota, cost, model and account identifiers are preserved.
 */
export function canonicalSpendLine(row: SpendDecision): string {
  let encoded: string;
  try {
    encoded = JSON.stringify(row);
  } catch {
    throw new SpendLedgerAppendError('spend decision is not encodable');
  }
  const normalized = parseSpendDecision(encoded);
  if (!normalized) throw new SpendLedgerAppendError('spend decision is incomplete or invalid');
  const line = `${JSON.stringify(normalized)}\n`;
  if (Buffer.byteLength(line, 'utf8') > SPEND_ROW_MAX_BYTES) {
    throw new SpendLedgerAppendError('spend decision exceeds the row ceiling');
  }
  return line;
}

/** Open an existing regular file without following a symlink; never creates it. */
function openExistingLedger(file: string, write: boolean): number {
  if (!isAbsolute(file)) throw new SpendLedgerAppendError('ledger path must be absolute');
  const mode = write ? constants.O_RDWR | constants.O_APPEND : constants.O_RDONLY;
  let fd: number;
  try {
    fd = openSync(file, mode | NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new SpendLedgerAppendError('ledger target is missing, unreadable, or a symlink');
  }
  try {
    if (!fstatSync(fd).isFile()) throw new SpendLedgerAppendError('ledger target is not a regular file');
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/**
 * Refuse unless one more line of `lineBytes` can be appended to the open file:
 * the last byte must be a newline (an unterminated row would be corrupted by a
 * new append) and the result must stay under the reader's byte ceiling, since
 * bytes past it are never read. Returns the current size.
 */
function assertAppendable(fd: number, lineBytes: number): number {
  const size = fstatSync(fd).size;
  if (size > 0) {
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    if (last[0] !== 0x0a) throw new SpendLedgerAppendError('ledger does not end with a newline; refusing to append');
  }
  if (size + lineBytes > SPEND_LEDGER_MAX_BYTES) {
    throw new SpendLedgerAppendError('ledger is at the read ceiling; refusing to append');
  }
  return size;
}

/** Read-only check used by preview: the same rules as apply, with no write. */
export function checkSpendLedgerTarget(file: string, lineBytes: number): { fileBytes: number } {
  const fd = openExistingLedger(file, false);
  try {
    return { fileBytes: assertAppendable(fd, lineBytes) };
  } finally {
    closeSync(fd);
  }
}

/**
 * Append one canonical JSON line. The row is validated before the file is
 * opened; O_APPEND keeps every earlier byte in place.
 */
export function appendSpendDecision(file: string, row: SpendDecision): { bytes: number } {
  const buf = Buffer.from(canonicalSpendLine(row), 'utf8');
  const fd = openExistingLedger(file, true);
  try {
    assertAppendable(fd, buf.length);
    let offset = 0;
    while (offset < buf.length) offset += writeSync(fd, buf, offset, buf.length - offset);
    fsyncSync(fd);
    return { bytes: buf.length };
  } finally {
    closeSync(fd);
  }
}
