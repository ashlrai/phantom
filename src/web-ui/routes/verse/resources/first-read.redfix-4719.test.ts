import { expect, it } from 'vitest';
import type { CapacityRow } from '../usage/capacity-strip-model.js';
import { shouldAutoCheck } from './first-read.js';

it('does not automatically check a subscription with recorded usage history', () => {
  const row: CapacityRow = {
    seatId: 'seat', label: 'Seat', engine: 'codex', monogram: 'C', kind: 'subscription', plan: null,
    cls: 'unread', word: 'no reading', summary: '', connection: null, windows: [], credits: null,
    reserve: null, notes: [], localCount: 1, checkedAt: null, resetAt: null, signedOut: false,
    historicalUsage: {
      observedAt: '2025-12-01T00:00:00.000Z', expiresAt: '2025-12-02T00:00:00.000Z', windows: [],
      source: 'native-account-checked-history', identitySource: 'native-account-checked',
    },
  };
  expect(shouldAutoCheck([row], { attempted: new Set() })).toEqual([]);
});
