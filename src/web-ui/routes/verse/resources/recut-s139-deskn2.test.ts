import { afterEach, expect, it } from 'vitest';
import type { CapacityRow } from '../usage/capacity-strip-model.js';
import { firstReadSession, markFirstReadAttempted, resetFirstReadSessionForTest, shouldAutoCheck } from './first-read.js';

afterEach(resetFirstReadSessionForTest);

it('checks an unread subscription only once per app session', () => {
  const seat: CapacityRow = {
    seatId: 'seat-a', label: 'Seat A', engine: 'codex', monogram: 'C', kind: 'subscription', plan: null,
    cls: 'unread' as CapacityRow['cls'], word: 'no reading', summary: '', connection: null, windows: [], credits: null,
    reserve: null, notes: [], localCount: 1, checkedAt: null, resetAt: null, signedOut: false,
  };
  expect(shouldAutoCheck([seat], firstReadSession())).toEqual(['seat-a']);
  markFirstReadAttempted('seat-a');
  expect(shouldAutoCheck([seat], firstReadSession())).toEqual([]);
});
