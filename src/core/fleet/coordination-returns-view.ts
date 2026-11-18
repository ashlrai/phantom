/**
 * Returns are evidence posted by an agent label, not authenticated authority.
 * VERIFIED means the returning agent named this evidence, not that Phantom checked the PR.
 */
import type { FleetBoard } from './coordination.js';

/** A receipt's qualification against the caller's observation clock at asOf. */
type Temporal = 'current' | 'expired' | 'future' | 'invalid';

interface Row {
  claimId: string;
  repo: string;
  result: 'VERIFIED' | 'BLOCKED';
  evidenceKind: 'pr' | 'tests' | 'artifact' | 'dependency';
  pr: number | null;
  head: string | null;
  evidence: string;
  from: string;
  at: string;
  expiresAt: string;
  /**
   * Temporal qualification of this receipt: current inside [at, expiresAt),
   * expired at or after expiry, future when the receipt post-dates the
   * observation, invalid on an unrenderable clock or non-positive lifetime.
   * Non-enumerable by design — the row's enumerable key set is a reviewed
   * evidence-only contract — so readers use row.temporal in memory and
   * serialized output emits it through toJSON.
   */
  readonly temporal: Temporal;
  /** Emits the enumerable fields plus temporal for JSON.stringify. */
  toJSON(): Record<string, unknown>;
}

function iso(ms: number): string {
  const time = new Date(ms).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : 'unknown';
}

/** Total clock check: NaN, infinities and finite values outside Date's range all fail. */
const renderable = (ms: number): boolean => Number.isFinite(new Date(ms).getTime());

/** Qualify a receipt's [at, expiresAt) window against the caller's observation clock. */
function temporalOf(at: number, expiresAt: number, observedAt: number): Temporal {
  if (!renderable(at) || !renderable(expiresAt) || !renderable(observedAt) || expiresAt <= at)
    return 'invalid';
  if (at > observedAt) return 'future';
  return observedAt >= expiresAt ? 'expired' : 'current';
}

function rowToJSON(this: Row): Record<string, unknown> {
  return { ...this, temporal: this.temporal };
}

// The task is quoted but unescaped by the writer, so consume through its final delimiter.
const RECEIPT = /^RESULT (VERIFIED|BLOCKED) ([A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}) claim ([A-Za-z0-9][A-Za-z0-9._:-]{0,127}) task "(.+)": ((pr) #([1-9]\d*) head ([a-fA-F0-9]{7,40})|(tests|artifact|dependency) (.+))$/;

/** Explicit selection keeps unrelated ledger fields out of the public projection. */
export function projectCoordinationReturns(board: FleetBoard | null, nowMs: number) {
  const base = { v: 1 as const, source: 'coordination-ledger' as const, asOf: iso(nowMs) };
  if (board === null || board.state === 'unknown') {
    return { ...base, state: 'unknown' as const, returns: [] as Row[], unparsed: 0,
      // Legacy unparsed stays compatible; coverage counters are unknown, not zero.
      coverage: { parsedTotal: null, omitted: null, unparsed: null },
      reason: 'coordination ledger: reader failed' };
  }
  const rows: { row: Row; at: number }[] = [];
  let unparsed = 0;
  for (const message of board.messages) {
    if (!message.id.startsWith('return-')) continue;
    const match = RECEIPT.exec(message.body);
    const kind = match?.[6] ?? match?.[9];
    const pr = match?.[7] === undefined ? null : Number(match[7]);
    if (!match || match[3] !== message.id.slice('return-'.length)
      || (match[1] === 'BLOCKED') !== (kind === 'dependency')
      || (pr !== null && !Number.isSafeInteger(pr))
      || (match[10] !== undefined && !match[10].trim())) {
      unparsed++;
      continue;
    }
    const row = {
      claimId: match[3]!, repo: match[2]!, result: match[1] as Row['result'],
      evidenceKind: kind as Row['evidenceKind'], pr, head: match[8] ?? null,
      evidence: match[5]!.slice(0, 300), from: message.from,
      at: iso(message.at), expiresAt: iso(message.expiresAt),
    } as Row;
    // temporal and toJSON stay off the enumerable surface; a retained board
    // re-projected at a later clock still qualifies the receipt honestly.
    Object.defineProperties(row, {
      temporal: { value: temporalOf(message.at, message.expiresAt, nowMs) },
      toJSON: { value: rowToJSON },
    });
    rows.push({ at: message.at, row });
  }
  return { ...base, state: 'known' as const,
    coverage: { parsedTotal: rows.length, omitted: Math.max(0, rows.length - 50), unparsed },
    returns: rows.sort((a, b) => b.at - a.at).slice(0, 50).map(entry => entry.row), unparsed };
}
