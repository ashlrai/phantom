/**
 * Returns are evidence posted by an agent label, not authenticated authority.
 * VERIFIED means the returning agent named this evidence, not that Phantom checked the PR.
 */
import type { FleetBoard } from './coordination.js';

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
}

function iso(ms: number): string {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : 'unknown';
}

// The task is quoted but unescaped by the writer, so consume through its final delimiter.
const RECEIPT = /^RESULT (VERIFIED|BLOCKED) ([A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}) claim ([A-Za-z0-9][A-Za-z0-9._:-]{0,127}) task "(.+)": ((pr) #([1-9]\d*) head ([a-fA-F0-9]{7,40})|(tests|artifact|dependency) (.+))$/;

/** Explicit selection keeps unrelated ledger fields out of the public projection. */
export function projectCoordinationReturns(board: FleetBoard | null, nowMs: number) {
  const base = { v: 1 as const, source: 'coordination-ledger' as const, asOf: iso(nowMs) };
  if (board === null || board.state === 'unknown') {
    return { ...base, state: 'unknown' as const, returns: [] as Row[], unparsed: 0,
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
    rows.push({ at: message.at, row: {
      claimId: match[3]!, repo: match[2]!, result: match[1] as Row['result'],
      evidenceKind: kind as Row['evidenceKind'], pr, head: match[8] ?? null,
      evidence: match[5]!.slice(0, 300), from: message.from,
      at: iso(message.at), expiresAt: iso(message.expiresAt),
    } });
  }
  return { ...base, state: 'known' as const,
    returns: rows.sort((a, b) => b.at - a.at).slice(0, 50).map(entry => entry.row), unparsed };
}
