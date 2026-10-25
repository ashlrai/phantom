/**
 * Custody section of `phm status`: receipt.v1 and the fleet custody ledger,
 * read-only and value-free. Shows counts, the receipt key id and whether the
 * newest receipt verifies. No secret names, values, paths or prompts.
 * Returns null when there is nothing to show (no key, no receipts, no spawns),
 * so status stays quiet on hosts that never opted in.
 */
import { receiptStatus, type ReceiptStatus } from '../core/receipt/receipt-store.js';
import { readCustodySummary, type CustodySummary } from '../core/run/custody-ledger.js';

export const CUSTODY_STATUS_WINDOW_HOURS = 24;

export interface CustodyStatus {
  receipts: {
    keyPresent: boolean;
    keyId: string | null;
    count: number;
    latest: { runId: string; verified: boolean; reason: string | null } | null;
  };
  spawns: {
    windowHours: number;
    total: number;
    wrapped: number;
    unwrapped: number;
    malformed: number;
  };
}

export interface CustodyStatusDeps {
  receipts?: () => ReceiptStatus;
  custody?: (since: Date) => CustodySummary;
  now?: () => Date;
}

export function gatherCustodyStatus(deps: CustodyStatusDeps = {}): CustodyStatus | null {
  const r = (deps.receipts ?? receiptStatus)();
  const now = (deps.now ?? (() => new Date()))();
  const since = new Date(now.getTime() - CUSTODY_STATUS_WINDOW_HOURS * 3_600_000);
  const c = (deps.custody ?? ((s: Date) => readCustodySummary(s)))(since);
  const unwrapped = Object.values(c.unwrapped).reduce<number>((a, n) => a + (n ?? 0), 0);
  if (!r.keyPresent && r.receipts === 0 && c.spawns === 0 && c.malformed === 0) return null;
  return {
    receipts: { keyPresent: r.keyPresent, keyId: r.keyId, count: r.receipts, latest: r.latest },
    spawns: { windowHours: CUSTODY_STATUS_WINDOW_HOURS, total: c.spawns, wrapped: c.wrapped, unwrapped, malformed: c.malformed },
  };
}

/** One plain-text line for the human board (callers add color). */
export function formatCustodyStatusLine(s: CustodyStatus): string {
  const parts: string[] = [];
  const latest = s.receipts.latest
    ? (s.receipts.latest.verified ? 'latest verified' : `latest NOT verified (${s.receipts.latest.reason ?? 'unknown'})`)
    : 'none yet';
  parts.push(`receipts ${s.receipts.count} (${latest})`);
  parts.push(s.receipts.keyPresent ? `key ${s.receipts.keyId ?? 'unknown'}` : 'no receipt key');
  parts.push(`spawns ${s.spawns.total} in ${s.spawns.windowHours}h: ${s.spawns.wrapped} wrapped, ${s.spawns.unwrapped} unwrapped`
    + (s.spawns.malformed > 0 ? `, ${s.spawns.malformed} malformed` : ''));
  return parts.join(' · ');
}
