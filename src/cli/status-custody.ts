/**
 * Custody section of `phm status`: receipt.v1 and the fleet custody ledger,
 * read-only and value-free. Shows counts, the receipt key id and whether the
 * newest receipt verifies. No secret names, values, paths or prompts.
 * Returns null when there is nothing to show (no key, no receipts, no spawns),
 * so status stays quiet on hosts that never opted in.
 */
import { receiptStatus, type ReceiptStatus } from '../core/receipt/receipt-store.js';
import { readCustodySummary, type CustodySummary } from '../core/run/custody-ledger.js';
import { UNWRAPPED_REASONS, type UnwrappedReason } from '../core/run/phantom-custody.js';

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
    /** Unwrapped spawns by fixed reason code (zero counts omitted), in UNWRAPPED_REASONS order. */
    unwrappedByReason: Partial<Record<UnwrappedReason, number>>;
    malformed: number;
  };
}

export interface CustodyStatusDeps {
  receipts?: () => ReceiptStatus;
  custody?: (since: Date) => CustodySummary;
  now?: () => Date;
}

function byReason(c: CustodySummary): Partial<Record<UnwrappedReason, number>> {
  const out: Partial<Record<UnwrappedReason, number>> = {};
  let stray = 0;
  for (const [k, n] of Object.entries(c.unwrapped)) if (!(UNWRAPPED_REASONS as readonly string[]).includes(k)) stray += n ?? 0;
  for (const r of UNWRAPPED_REASONS) {
    const n = (c.unwrapped[r] ?? 0) + (r === 'unknown' ? stray : 0);
    if (n > 0) out[r] = n;
  }
  return out;
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
    spawns: { windowHours: CUSTODY_STATUS_WINDOW_HOURS, total: c.spawns, wrapped: c.wrapped, unwrapped, unwrappedByReason: byReason(c), malformed: c.malformed },
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
  const reasons = Object.entries(s.spawns.unwrappedByReason ?? {}).map(([r, n]) => `${r} ${n}`).join(', ');
  parts.push(`spawns ${s.spawns.total} in ${s.spawns.windowHours}h: ${s.spawns.wrapped} wrapped, ${s.spawns.unwrapped} unwrapped`
    + (reasons ? ` (${reasons})` : '')
    + (s.spawns.malformed > 0 ? `, ${s.spawns.malformed} malformed` : ''));
  return parts.join(' · ');
}
