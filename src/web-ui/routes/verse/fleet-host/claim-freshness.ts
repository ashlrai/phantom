import type { ParsedClaimExecution } from './claim-execution-model.js';

type ClaimRow = Extract<ParsedClaimExecution, { kind: 'ok' }>['rows'][number];
type Lease = Pick<ClaimRow, 'expiresInSeconds'>;
type ReadAt = string | null | undefined;

/** Lease seconds are relative to the API report's asOf, never the render time. */
export function claimFreshness(row: Lease, readAt: ReadAt, now: number): { stale: boolean; expired: boolean; label: string } {
  const readMs = readAt ? Date.parse(readAt) : NaN;
  const known = Number.isFinite(readMs);
  const elapsed = known ? Math.max(0, now - readMs) : 0;
  const expired = row.expiresInSeconds !== 'unknown'
    && (row.expiresInSeconds <= 0 || (known && elapsed >= row.expiresInSeconds * 1000));
  const time = known ? new Date(readMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : null;
  return {
    stale: !known || elapsed > 120_000 || expired,
    expired,
    label: time === null ? 'as of unknown' : `as of ${time} · claim execution API`,
  };
}

/** Keep the API ordering within each group and leave the original rows untouched. */
export function sortByFreshness<T extends Lease>(rows: readonly T[], readAt: ReadAt, now: number): T[] {
  return [...rows].sort((a, b) => Number(claimFreshness(a, readAt, now).expired) - Number(claimFreshness(b, readAt, now).expired));
}
