/**
 * Durable sink for `phm fleet reverts` detections.
 *
 * `detectRevertOutcomes` / `buildRevertScanReport` (./reverted.ts,
 * ./revert-scan.ts) find merged PRs whose revert landed within
 * `REVERT_WINDOW_MS` of the merge — but the scan is a manual, read-only
 * report: its `RevertOutcomeRecord`s used to evaporate with the process, so
 * the only revert evidence any consumer could see was what jobs.jsonl,
 * cloud tasks or the self-improvement outcome ledger happened to record.
 * A revert visible only in git history (a hand-landed revert commit, a
 * revert PR that never wrote a jobs row for the original job) reached no
 * consumer at all.
 *
 * This module is the missing sink: `recordRevertOutcomes` appends validated
 * detections to `$ASHLR_HOME/improve/revert-outcomes.jsonl`, an append-only
 * JSONL ledger beside `outcomes.jsonl`. `readRevertOutcomeRecords` verifies
 * it fail-closed (a corrupt or oversized file is `intact: false`, never a
 * partial-trust read) and `standingRevertKeys` resolves the newest record
 * per PR — a later record whose `relandedBy` is set clears the earlier
 * revert, matching the re-land rule `scoreOutcomes` applies to the outcome
 * ledger. `revertedPrKeys` folds the standing set in, so knowledge notes
 * citing a git-detected-reverted PR are withheld like any other reverted
 * work.
 *
 * Honesty rules: a record that fails validation is a programmer error and
 * throws rather than being silently dropped; an exact duplicate (same PR,
 * same revert commit, same reland state) is skipped and counted, while any
 * differing field is new evidence and appends — rescanning deeper history
 * that reveals a reland must never be deduped away.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import { prKey } from './lesson-trial.js';
import type { RevertOutcomeRecord } from './reverted.js';

export const REVERT_OUTCOMES_LEDGER_RELATIVE = join('improve', 'revert-outcomes.jsonl');
export const MAX_REVERT_LEDGER_BYTES = 8 * 1024 * 1024;

const SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;

export function revertOutcomesLedgerPath(rootDir?: string): string {
  return join(rootDir ?? ashlrHome(), REVERT_OUTCOMES_LEDGER_RELATIVE);
}

export interface RevertLedgerRead {
  records: RevertOutcomeRecord[];
  /** False when the file exists but cannot be trusted whole; records is then the verified prefix (empty on oversize). */
  intact: boolean;
  reasons: string[];
  /** 'missing' = no ledger file; 'read' = verified whole; 'unreadable' = exists but untrusted (corrupt or oversized). */
  state: 'missing' | 'read' | 'unreadable';
}

export interface RevertRecordResult {
  appended: number;
  /** Exact duplicates already in the ledger or repeated in the batch. */
  duplicates: number;
  path: string;
}

const iso = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
const shaOrNull = (v: unknown): v is string | null => v === null || (typeof v === 'string' && SHA.test(v));

/** Strict shape check; throws on anything that is not a well-formed detection. */
export function validateRevertOutcomeRecord(value: unknown): RevertOutcomeRecord {
  const r = value as RevertOutcomeRecord;
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('Revert outcome record must be an object.');
  if (typeof r.repository !== 'string' || !REPOSITORY.test(r.repository)) throw new Error('Invalid repository.');
  if (!Number.isSafeInteger(r.number) || r.number <= 0) throw new Error('Invalid PR number.');
  if (r.pr !== prKey(r.repository, r.number)) throw new Error('PR key does not match repository and number.');
  if (typeof r.mergeSha !== 'string' || !SHA.test(r.mergeSha)) throw new Error('Invalid merge commit.');
  if (!iso(r.mergedAt) || !iso(r.revertedAt)) throw new Error('Revert record needs parseable merge and revert times.');
  if (typeof r.revertedBy !== 'string' || !SHA.test(r.revertedBy)) throw new Error('Invalid revert commit.');
  if (!shaOrNull(r.relandedBy)) throw new Error('Invalid reland commit.');
  if (typeof r.revertLatencyMs !== 'number' || !Number.isFinite(r.revertLatencyMs)) throw new Error('Invalid revert latency.');
  return {
    repository: r.repository, number: r.number, pr: r.pr, mergeSha: r.mergeSha,
    mergedAt: r.mergedAt, revertedBy: r.revertedBy, revertedAt: r.revertedAt,
    revertLatencyMs: r.revertLatencyMs, relandedBy: r.relandedBy,
  };
}

/** Stored line: a versioned envelope around the record so append time stays with the evidence. */
interface LedgerLine { v: 1; at: string; record: RevertOutcomeRecord }

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

/**
 * Read and verify the ledger. Missing file is an empty intact read — an
 * absent append-only journal means no recorded detections, not an error.
 * A malformed line keeps the verified prefix and marks the read non-intact,
 * matching `readLedger`'s fail-closed chain semantics minus the hash chain
 * (these are scan outputs, not signed evidence).
 */
export function readRevertOutcomeRecords(
  path = revertOutcomesLedgerPath(),
  opts: { maxBytes?: number } = {},
): RevertLedgerRead {
  if (!existsSync(path)) return { records: [], intact: true, reasons: [], state: 'missing' };
  const raw = readFileSync(path, 'utf8');
  if (raw.length > (opts.maxBytes ?? MAX_REVERT_LEDGER_BYTES)) {
    return { records: [], intact: false, reasons: ['ledger-too-large'], state: 'unreadable' };
  }
  const records: RevertOutcomeRecord[] = [];
  for (const [i, line] of raw.split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as LedgerLine;
      if (parsed.v !== 1 || typeof parsed.at !== 'string' || !Number.isFinite(Date.parse(parsed.at))) {
        return { records, intact: false, reasons: [`unreadable-line-${i + 1}`], state: 'unreadable' };
      }
      records.push(validateRevertOutcomeRecord(parsed.record));
    } catch {
      return { records, intact: false, reasons: [`unreadable-line-${i + 1}`], state: 'unreadable' };
    }
  }
  return { records, intact: true, reasons: [], state: 'read' };
}

/**
 * Append detections to the ledger. Exact duplicates — the same record a
 * previous scan of unchanged history already wrote — are skipped; any field
 * that differs (a reland found by a deeper scan, a different revert commit)
 * is new evidence and appends. Throws when the ledger is not intact: a
 * corrupt evidence file is never appended over.
 */
export function recordRevertOutcomes(
  records: readonly RevertOutcomeRecord[],
  opts: { path?: string; now?: Date } = {},
): RevertRecordResult {
  const path = opts.path ?? revertOutcomesLedgerPath();
  const read = readRevertOutcomeRecords(path);
  if (!read.intact) throw new Error(`Revert outcomes ledger is not intact (${read.reasons.join(', ')}); refusing to append.`);
  const seen = new Set(read.records.map((r) => canonical(r)));
  const lines: string[] = [];
  let duplicates = 0;
  for (const value of records) {
    const record = validateRevertOutcomeRecord(value);
    const key = canonical(record);
    if (seen.has(key)) { duplicates += 1; continue; }
    seen.add(key);
    const line: LedgerLine = { v: 1, at: (opts.now ?? new Date()).toISOString(), record };
    lines.push(JSON.stringify(line));
  }
  if (lines.length > 0) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, `${lines.join('\n')}\n`, { mode: 0o600 });
  }
  return { appended: lines.length, duplicates, path };
}

/**
 * The prKey set whose LAST recorded detection still stands: iterate in
 * ledger order so a later record supersedes an earlier one for the same PR,
 * then keep the keys whose newest record has no `relandedBy`. A scan that
 * reaches deeper history and finds the revert itself was reverted clears
 * the key — the change stands again.
 */
export function standingRevertKeys(records: readonly RevertOutcomeRecord[]): Set<string> {
  const last = new Map<string, RevertOutcomeRecord>();
  for (const record of records) last.set(record.pr, record);
  const keys = new Set<string>();
  for (const [key, record] of last) if (record.relandedBy === null) keys.add(key);
  return keys;
}

/**
 * Standing revert keys read straight from the ledger path — the one-call
 * form for consumers that join by PR identity (the router outcome fold,
 * outcome learning). Anything but a fully intact 'read' contributes an
 * empty set: a missing ledger means no recorded detections, and corrupt or
 * oversized evidence never discounts a merge.
 */
export function readStandingRevertKeys(path = revertOutcomesLedgerPath()): ReadonlySet<string> {
  const read = readRevertOutcomeRecords(path);
  return read.state === 'read' ? standingRevertKeys(read.records) : new Set<string>();
}
