import { describe, expect, it } from 'vitest';
import { FOLLOW_UP_MAX, orderFollowUpEligible, orderFollowUpPrefill } from './order-follow-up.js';
import { ORDER_STATES, type OrderRow } from './order-state-model.js';

const row = (over: Partial<OrderRow> = {}): OrderRow => ({
  at: '2026-11-13T13:13:00.000Z', source: 'slack', key: '11-13 13:13', state: 'BLOCKED', asOf: '2026-11-13T13:14:00.000Z',
  evidenceSource: 'ledger', missing: ['pr', 'verify'], pr: null, owner: { job: 'RQ-FAKE-1', lane: 'devin' }, ...over,
});

describe('orderFollowUpEligible', () => {
  it('is true only for RECEIVED, ASSIGNED and BLOCKED', () => {
    const got = Object.fromEntries(ORDER_STATES.map((s) => [s, orderFollowUpEligible(row({ state: s }))]));
    expect(got).toEqual({ RECEIVED: true, ASSIGNED: true, RUNNING: false, BLOCKED: true, VERIFIED: false });
  });
});

describe('orderFollowUpPrefill', () => {
  it('names the order, state and missing evidence and ends with a space', () => {
    expect(orderFollowUpPrefill(row())).toBe('Follow-up on my Nov 13 13:13 order (BLOCKED; missing: pr, verify): ');
  });
  it('drops the missing part when empty and strips the day zero', () => {
    expect(orderFollowUpPrefill(row({ key: '01-05 09:07', state: 'RECEIVED', missing: [] }))).toBe('Follow-up on my Jan 5 09:07 order (RECEIVED): ');
  });
  it('returns null for malformed keys', () => {
    for (const key of ['13-40 25:00', '', '11-13', '11-32 10:00', '00-10 10:00', '11-13 24:00', 'order-fake-1']) {
      expect(orderFollowUpPrefill(row({ key }))).toBeNull();
    }
  });
  it('holds the cap and keeps the trailing ": "', () => {
    const p = orderFollowUpPrefill(row({ missing: ['x'.repeat(500)] }))!;
    expect(p.length).toBeLessThanOrEqual(FOLLOW_UP_MAX);
    expect(p.endsWith('): ')).toBe(true);
  });
  it('uses the date shape the planner citation parser matches', () => {
    // Inner date regex copied from src/core/fleet/order-trace.ts parseOrderCitations.
    const inner = /\b(?:(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+)?([0-2]\d:[0-5]\d)\b/i;
    const p = orderFollowUpPrefill(row())!;
    const m = inner.exec(p.slice(p.indexOf('my ') + 3))!;
    expect([m[1], m[2], m[3]]).toEqual(['Nov', '13', '13:13']);
    expect(`Serves Mason's ${m[0]}`).toBe("Serves Mason's Nov 13 13:13");
  });
});
