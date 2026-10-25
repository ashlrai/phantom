/**
 * Fleet custody ledger (design-custody-fleet.md 3.3, fleet slice C1).
 *
 * Append-only JSONL at ~/.ashlr/custody/spawns.jsonl: one value-free line per
 * phantom-enabled engine spawn, including every fleet worktree spawn. A line
 * is the custody record plus a timestamp. No paths, secret names, values or
 * error strings. Writes are best effort and never block or fail a spawn.
 * The file is capped; past the cap it rotates once to spawns.jsonl.1.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { normalizeUnwrappedReason, type PhantomCustodyRecord, type UnwrappedReason } from './phantom-custody.js';

export const CUSTODY_LEDGER_SCHEMA = 1 as const;
export const CUSTODY_LEDGER_MAX_BYTES = 4 * 1024 * 1024;

export function custodyLedgerPath(): string {
  return join(homedir(), '.ashlr', 'custody', 'spawns.jsonl');
}

/** Append one record. Never throws. */
export function appendCustodyRecord(record: PhantomCustodyRecord, now: Date = new Date()): void {
  try {
    const path = custodyLedgerPath();
    mkdirSync(join(homedir(), '.ashlr', 'custody'), { recursive: true, mode: 0o700 });
    try {
      if (statSync(path).size >= CUSTODY_LEDGER_MAX_BYTES) renameSync(path, `${path}.1`);
    } catch { /* absent: first write */ }
    const line = record.wrapped
      ? { schema: CUSTODY_LEDGER_SCHEMA, at: now.toISOString(), wrapped: true, engine: record.engine, preflight_exit: record.preflight_exit }
      : { schema: CUSTODY_LEDGER_SCHEMA, at: now.toISOString(), wrapped: false, reason: record.reason, engine: record.engine, preflight_exit: record.preflight_exit };
    appendFileSync(path, `${JSON.stringify(line)}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch { /* best effort */ }
}

export interface CustodySummary {
  spawns: number;
  wrapped: number;
  unwrapped: Partial<Record<UnwrappedReason, number>>;
  malformed: number;
}

/** Count records at or after `since` (current file only). Never throws; a missing file is all zeros. */
export function readCustodySummary(since: Date | null, text?: string): CustodySummary {
  const out: CustodySummary = { spawns: 0, wrapped: 0, unwrapped: {}, malformed: 0 };
  let body = text;
  if (body === undefined) {
    try { body = readFileSync(custodyLedgerPath(), 'utf8'); } catch { return out; }
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
