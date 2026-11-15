import { describe, expect, it } from 'vitest';
import type { BudgetView } from '../../../../core/routing/policy.js';
import { automaticReserveSeats } from './budget-model.js';

function fixture(): BudgetView {
  return {
    mode: 'balanced', seats: {}, updatedAt: '', sampledAt: '', readingMaxAgeMs: 1000, headroom: [],
    seatInfo: [
      { seatId: 'claude-fake', label: 'Claude', engine: 'claude', free: false },
      { seatId: 'codex-fake', label: 'Codex', engine: 'codex', free: false },
      { seatId: 'devin-fake', label: 'Devin', engine: 'devin', free: false },
      { seatId: 'local-fake', label: 'Local', engine: 'local', free: true },
    ],
    effective: Object.fromEntries([
      ['claude-fake', true, 40, 70], ['codex-fake', true, 40, 70],
      ['grok-fake', true, 0, null], ['devin-fake', true, 0, null],
      ['local-fake', true, 0, null], ['claude-disabled-fake', false, 85, 70],
    ].map(([seatId, enabled, reservePercent, maxSessionWindowPercent]) => [seatId, { seatId, enabled, reservePercent, maxSessionWindowPercent }])),
  } as BudgetView;
}

describe('automaticReserveSeats', () => {
  it('returns enabled seats with restrictions in seat order', () => {
    expect(automaticReserveSeats(fixture())).toEqual([
      { seatId: 'claude-fake', reservePercent: 40, maxSessionWindowPercent: 70 },
      { seatId: 'codex-fake', reservePercent: 40, maxSessionWindowPercent: 70 },
    ]);
  });
  it('returns nothing when all restrictions are cleared', () => {
    const view = fixture();
    for (const policy of Object.values(view.effective)) { policy.reservePercent = 0; policy.maxSessionWindowPercent = 100; }
    expect(automaticReserveSeats(view)).toEqual([]);
  });
});
