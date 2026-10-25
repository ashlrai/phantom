import { describe, expect, it } from 'vitest';
import { formatCustodyStatusLine, gatherCustodyStatus } from '../src/cli/status-custody.js';
import type { ReceiptStatus } from '../src/core/receipt/receipt-store.js';
import type { CustodySummary } from '../src/core/run/custody-ledger.js';

const NOW = new Date('2026-10-25T09:00:00Z');
const noReceipts: ReceiptStatus = { keyPresent: false, keyId: null, receipts: 0, latest: null };
const noSpawns: CustodySummary = { spawns: 0, wrapped: 0, unwrapped: {}, malformed: 0 };

describe('phm status custody section', () => {
  it('is null when nothing was ever recorded', () => {
    expect(gatherCustodyStatus({ receipts: () => noReceipts, custody: () => noSpawns, now: () => NOW })).toBeNull();
  });

  it('reads the custody ledger over the last 24 hours', () => {
    let seen: Date | null = null;
    gatherCustodyStatus({ receipts: () => noReceipts, custody: (s) => { seen = s; return noSpawns; }, now: () => NOW });
    expect(seen).toEqual(new Date('2026-10-24T09:00:00Z'));
  });

  it('reports receipt counts, key id, latest verification and spawn totals', () => {
    const s = gatherCustodyStatus({
      receipts: () => ({ keyPresent: true, keyId: 'k1', receipts: 3, latest: { runId: 'run-3', verified: true, reason: null } }),
      custody: () => ({ spawns: 5, wrapped: 3, unwrapped: { 'phantom-unavailable': 1, 'preflight-blocked': 1 } as CustodySummary['unwrapped'], malformed: 0 }),
      now: () => NOW,
    });
    expect(s).toEqual({
      receipts: { keyPresent: true, keyId: 'k1', count: 3, latest: { runId: 'run-3', verified: true, reason: null } },
      spawns: { windowHours: 24, total: 5, wrapped: 3, unwrapped: 2, malformed: 0 },
    });
    expect(formatCustodyStatusLine(s!)).toBe('receipts 3 (latest verified) · key k1 · spawns 5 in 24h: 3 wrapped, 2 unwrapped');
  });

  it('flags an unverified latest receipt and malformed ledger lines', () => {
    const s = gatherCustodyStatus({
      receipts: () => ({ keyPresent: false, keyId: null, receipts: 1, latest: { runId: 'r', verified: false, reason: 'bad-signature' } }),
      custody: () => ({ ...noSpawns, malformed: 2 }),
      now: () => NOW,
    });
    expect(formatCustodyStatusLine(s!)).toBe('receipts 1 (latest NOT verified (bad-signature)) · no receipt key · spawns 0 in 24h: 0 wrapped, 0 unwrapped, 2 malformed');
  });

  it('never carries names, values or paths', () => {
    const s = gatherCustodyStatus({
      receipts: () => ({ keyPresent: true, keyId: 'k', receipts: 1, latest: { runId: 'r', verified: true, reason: null } }),
      custody: () => ({ spawns: 1, wrapped: 1, unwrapped: {}, malformed: 0 }),
      now: () => NOW,
    });
    const text = JSON.stringify(s) + formatCustodyStatusLine(s!);
    expect(text).not.toMatch(/\/|secret|token|HOME/i);
  });
});
