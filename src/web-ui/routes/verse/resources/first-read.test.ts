import { afterEach, describe, expect, it } from 'vitest';
import type { CapacityRow } from '../usage/capacity-strip-model.js';
import { firstReadSession, markFirstReadAttempted, resetFirstReadSessionForTest, shouldAutoCheck, type FirstReadSession } from './first-read.js';

function row(over: Partial<CapacityRow> = {}): CapacityRow {
  return {
    seatId: 'synthetic', label: 'Synthetic', engine: 'codex', monogram: 'C', kind: 'subscription', plan: null,
    cls: 'unread' as CapacityRow['cls'], word: 'no reading', summary: '', connection: null, windows: [], credits: null,
    reserve: null, notes: [], localCount: 1, checkedAt: null, resetAt: null, signedOut: false, ...over,
  };
}

const session = (attempted: readonly string[] = []): FirstReadSession => ({ attempted: new Set(attempted) });

describe('shouldAutoCheck', () => {
  afterEach(resetFirstReadSessionForTest);

  it('returns a never-read subscription seat', () => {
    expect(shouldAutoCheck([row()], session())).toEqual(['synthetic']);
  });

  it('returns every never-read seat in roster order', () => {
    const rows = [row({ seatId: 'claude-a', engine: 'claude' }), row({ seatId: 'codex-a' }), row({ seatId: 'grok-a', engine: 'grok' })];
    expect(shouldAutoCheck(rows, session())).toEqual(['claude-a', 'codex-a', 'grok-a']);
  });

  it('skips a signed-out seat: its fix is reconnect, not a usage check', () => {
    expect(shouldAutoCheck([row({ signedOut: true })], session())).toEqual([]);
  });

  it('skips a seat already attempted this session', () => {
    expect(shouldAutoCheck([row()], session(['synthetic']))).toEqual([]);
  });

  it('skips a seat that already has a current or retained reading', () => {
    const measured = row({ windows: [{ id: 'w', label: 'weekly window', usedPercent: 40, limitReached: false, resetText: null, resetsAt: null, binding: true }] });
    const flagged = row({ seatId: 'flagged', windows: [{ id: 'w', label: 'weekly window', usedPercent: null, limitReached: true, resetText: null, resetsAt: null, binding: true }] });
    expect(shouldAutoCheck([measured, flagged], session())).toEqual([]);
  });

  it('still returns a checked seat that produced no reading: it is missing, so it gets its one retry', () => {
    const rows = [
      row({ checkedAt: '2026-01-01T12:00:00.000Z' }),
      row({ seatId: 'observed-empty', usageObservedAt: '2026-01-01T12:00:00.000Z' }),
      row({ seatId: 'timed-out', engine: 'claude', quotaReadReason: 'status-timed-out' }),
    ];
    expect(shouldAutoCheck(rows, session())).toEqual(['synthetic', 'observed-empty', 'timed-out']);
  });

  it('skips a seat with recorded history', () => {
    const history: NonNullable<CapacityRow['historicalUsage']> = { observedAt: '2025-12-01T00:00:00.000Z', expiresAt: '2025-12-02T00:00:00.000Z', windows: [], source: 'native-account-checked-history', identitySource: 'native-account-checked' };
    expect(shouldAutoCheck([row({ historicalUsage: history })], session())).toEqual([]);
  });

  it('skips local and Devin rows: neither reads through the native account check', () => {
    expect(shouldAutoCheck([row({ seatId: 'local', kind: 'local', engine: 'local' })], session())).toEqual([]);
    expect(shouldAutoCheck([row({ seatId: 'devin', engine: 'devin' })], session())).toEqual([]);
  });

  it('treats an unparseable check stamp as never checked', () => {
    expect(shouldAutoCheck([row({ checkedAt: 'not-a-date' })], session())).toEqual(['synthetic']);
  });
});

describe('firstReadSession', () => {
  afterEach(resetFirstReadSessionForTest);

  it('remembers attempted seats for the app session', () => {
    expect(shouldAutoCheck([row()], firstReadSession())).toEqual(['synthetic']);
    markFirstReadAttempted('synthetic');
    expect(shouldAutoCheck([row()], firstReadSession())).toEqual([]);
    expect(shouldAutoCheck([row({ seatId: 'other' })], firstReadSession())).toEqual(['other']);
  });
});
