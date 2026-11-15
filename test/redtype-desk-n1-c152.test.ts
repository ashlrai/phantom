// RQ-PHX-REDTYPEDESKN1C152 — regression for PR #4828's Quick typecheck fix:
// `automaticReserveSeats` must also skip Devin seats. The wire type
// (`CapacityEngine` = `Exclude<BudgetEngine, 'devin'>`) cannot express the
// check, but real wire data can still carry `engine: 'devin'` — the seatInfo
// row is read defensively at runtime, exactly like the rest of this model.
import { describe, expect, it } from 'vitest';
import { automaticReserveSeats } from '../src/web-ui/routes/verse/budget/budget-model.js';

type View = Parameters<typeof automaticReserveSeats>[0];

function fixture(): View {
  return {
    mode: 'balanced', seats: {}, updatedAt: '', sampledAt: '', readingMaxAgeMs: 1000, headroom: [],
    seatInfo: [
      { seatId: 'claude-fake', label: 'Claude', engine: 'claude', free: false },
      { seatId: 'devin-fake', label: 'Devin', engine: 'devin', free: false },
      { seatId: 'local-fake', label: 'Local', engine: 'local', free: true },
    ],
    effective: Object.fromEntries([
      ['claude-fake', 40, 70],
      ['devin-fake', 40, 70],
      ['local-fake', 40, 70],
    ].map(([seatId, reservePercent, maxSessionWindowPercent]) => [seatId, { seatId, enabled: true, reservePercent, maxSessionWindowPercent }])),
  } as View;
}

describe('automaticReserveSeats', () => {
  it('lists enabled restricted seats but never Devin or local seats', () => {
    expect(automaticReserveSeats(fixture())).toEqual([
      { seatId: 'claude-fake', reservePercent: 40, maxSessionWindowPercent: 70 },
    ]);
  });
});
