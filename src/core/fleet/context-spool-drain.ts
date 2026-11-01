/**
 * Bounded preview/apply over the context-reply spool directory. Apply only
 * republishes each selected record through the existing
 * deliverSpooledContextReply: record format, TTL, writer.lock discipline, bus
 * dedupe and deletion semantics are exactly the single-record path's, and no
 * worker argv is ever executed. Reports names and status counts only — never
 * envelope bodies, raw reply ids or filesystem paths.
 *
 * `afterRecord` resumes a bounded sweep past records an earlier batch already
 * covered, so a retained failure can no longer starve the replies sorted
 * behind it; `nextRecord` reports the resume point and is null at end of
 * sweep (never a wrap-around to the first record).
 */
import { lstatSync, opendirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import type { BusInboxOptions } from './bus-inbox.js';
import {
  deliverSpooledContextReply, SPOOL_MAX_RECORDS,
  type ContextDeliverRetryResult, type ContextDeliveryStatus,
} from './context-reply-spool.js';

/** Same cap the spool itself accepts; a drain batch is at most this large. */
export const DRAIN_MAX_LIMIT = SPOOL_MAX_RECORDS;
/** Bound on directory entries inspected, including non-record surprises. */
export const DRAIN_SCAN_CAP = 2048;
const RECORD_PATTERN = /^reply-[0-9a-f]{32}\.json$/;
/** Lowest possible record name; a resume cursor that claims no coverage. */
const FIRST_RECORD_NAME = `reply-${'0'.repeat(32)}.json`;

export interface ContextSpoolDrainReport {
  status: 'ok' | 'invalid' | 'unsafe';
  mode: 'preview' | 'apply';
  /** Directory entries inspected before the scan cap stopped enumeration. */
  scanned: number;
  /** Record-pattern names found in the scanned prefix. */
  matched: number;
  /** Records previewed or attempted (at most the limit). */
  selected: number;
  /** More matching records exist than the selected batch. */
  truncated: boolean;
  /** Directory held more entries than the scan cap; matched is a lower bound. */
  overflow: boolean;
  /** Selected record file names (hashed names only, never paths or raw ids). */
  records: string[];
  /** Apply mode: delivery status counts over the selected batch. */
  counts: Partial<Record<ContextDeliveryStatus, number>>;
  /** Apply mode: selected names still on disk after the run. */
  retained: string[];
  /** Resume cursor for a later `afterRecord` call: the last hashed name this
   * batch covered (attempted, retained or not). Null only at the end of a
   * fully scanned sweep — the cursor never wraps to the start. When the scan
   * cap cut enumeration off, unscanned entries may sort anywhere, so the
   * cursor stays at the last certainly-covered name instead of implying
   * coverage of records the scan never saw. */
  nextRecord: string | null;
  /** 0 complete, 1 incomplete but retryable, 2 invalid or refused. */
  exitCode: number;
}

export interface ContextSpoolDrainOptions {
  spoolDir: string;
  apply?: boolean;
  limit?: number;
  /** Resume a bounded sweep: only scanned record names lexically after this
   * hashed record name are selected. Must match the record-name shape; it is
   * never treated as a path, and a name absent from disk still works because
   * selection is a pure lexical comparison. */
  afterRecord?: string;
}

/** Mirrors the spool module's own directory gate (its check stays private). */
function safeSpoolDirectory(dir: string): boolean {
  try {
    const stat = lstatSync(dir);
    return stat.isDirectory() && !stat.isSymbolicLink() &&
      (typeof process.getuid !== 'function' || stat.uid === process.getuid()) &&
      (process.platform === 'win32' || (stat.mode & 0o777) === 0o700) &&
      assurePrivateStoragePath(dir, 'directory', 'inspect-existing', { anchorPath: dirname(dir) }).ok;
  } catch { return false; }
}

/** Stream names bounded by DRAIN_SCAN_CAP; sorting keeps the batch deterministic. */
function scanSpoolDirectory(dir: string): { names: string[]; scanned: number; overflow: boolean } {
  const names: string[] = [];
  let scanned = 0, overflow = false;
  const entries = opendirSync(dir);
  try {
    for (let entry = entries.readSync(); entry !== null; entry = entries.readSync()) {
      if (scanned >= DRAIN_SCAN_CAP) { overflow = true; break; }
      scanned += 1;
      if (RECORD_PATTERN.test(entry.name)) names.push(entry.name);
    }
  } finally { entries.closeSync(); }
  names.sort();
  return { names, scanned, overflow };
}

export function drainContextReplySpool(opts: ContextSpoolDrainOptions, bus: BusInboxOptions = {}): ContextSpoolDrainReport {
  const limit = opts.limit ?? DRAIN_MAX_LIMIT;
  const after = opts.afterRecord;
  const refuse = (status: 'invalid' | 'unsafe', nextRecord: string | null = null): ContextSpoolDrainReport => ({
    status, mode: opts.apply ? 'apply' : 'preview', scanned: 0, matched: 0, selected: 0,
    truncated: false, overflow: false, records: [], counts: {}, retained: [], nextRecord, exitCode: 2,
  });
  if (!isAbsolute(opts.spoolDir) || opts.spoolDir.includes('\0') ||
    !Number.isSafeInteger(limit) || limit < 1 || limit > DRAIN_MAX_LIMIT ||
    (after !== undefined && !RECORD_PATTERN.test(after))) return refuse('invalid');
  if (!safeSpoolDirectory(opts.spoolDir)) return refuse('unsafe', after ?? null);
  let scan: ReturnType<typeof scanSpoolDirectory>;
  try { scan = scanSpoolDirectory(opts.spoolDir); } catch { return refuse('unsafe', after ?? null); }
  const remaining = after === undefined ? scan.names : scan.names.filter(name => name > after);
  const selected = remaining.slice(0, limit);
  const truncated = remaining.length > selected.length;
  // A null cursor is the explicit end of sweep and never wraps. Under overflow
  // unscanned entries may sort anywhere, so only the incoming cursor (or the
  // lowest record name, claiming nothing) is honest; otherwise the cursor is
  // the last selected name, which advances past retained records too.
  const nextRecord = scan.overflow ? (after ?? FIRST_RECORD_NAME)
    : truncated ? (selected.at(-1) ?? null)
    : null;
  const base = {
    status: 'ok' as const, scanned: scan.scanned, matched: scan.names.length,
    selected: selected.length, truncated, overflow: scan.overflow, nextRecord,
  };
  if (!opts.apply) {
    return { ...base, mode: 'preview', records: selected, counts: {}, retained: [], exitCode: 0 };
  }
  const counts: Partial<Record<ContextDeliveryStatus, number>> = {};
  const retained: string[] = [];
  let worst = 0;
  for (const name of selected) {
    // A locked, missing or refused record never stops the rest of the batch.
    let outcome: ContextDeliverRetryResult;
    try { outcome = deliverSpooledContextReply(join(opts.spoolDir, name), bus); }
    catch { outcome = { workerExit: { status: 'unknown' }, delivery: { status: 'spool-failed' }, exitCode: 2 }; }
    const status = outcome.delivery.status;
    counts[status] = (counts[status] ?? 0) + 1;
    // 'missing' resolved elsewhere: counted, but neither retained nor a failure here.
    if (status !== 'missing') {
      if (status !== 'posted' && status !== 'duplicate') retained.push(name);
      if (outcome.exitCode > worst) worst = outcome.exitCode;
    }
  }
  return { ...base, mode: 'apply', records: selected, counts, retained,
    exitCode: Math.max(worst, truncated || scan.overflow ? 1 : 0) };
}
