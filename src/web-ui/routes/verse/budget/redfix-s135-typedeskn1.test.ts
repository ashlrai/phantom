import { describe, expect, it } from 'vitest';
import type { BudgetView } from '../../../../core/routing/policy.js';
import { automaticReserveSeats } from './budget-model.js';

function view(
  policies: Record<string, { enabled: boolean; reservePercent: number; maxSessionWindowPercent?: number }>,
  seatInfo: BudgetView['seatInfo'] = [],
): BudgetView {
  return {
    mode: 'balanced', seats: {}, updatedAt: '', sampledAt: '', readingMaxAgeMs: 1000, headroom: [],
    seatInfo,
    effective: Object.fromEntries(Object.entries(policies).map(([seatId, p]) => [seatId, { seatId, ...p }])),
  };
}

describe('automaticReserveSeats (redfix-s135-typedeskn1)', () => {
  it('keeps restricted paid seats and skips local seats by engine', () => {
    const v = view(
      {
        'claude-fake': { enabled: true, reservePercent: 40, maxSessionWindowPercent: 70 },
        'codex-fake': { enabled: true, reservePercent: 40 },
        'local-fake': { enabled: true, reservePercent: 40, maxSessionWindowPercent: 70 },
      },
      [
        { seatId: 'claude-fake', label: 'Claude', engine: 'claude', free: false },
        { seatId: 'codex-fake', label: 'Codex', engine: 'codex', free: false },
        { seatId: 'local-fake', label: 'Local', engine: 'local', free: true },
      ],
    );
    expect(automaticReserveSeats(v)).toEqual([
      { seatId: 'claude-fake', reservePercent: 40, maxSessionWindowPercent: 70 },
      { seatId: 'codex-fake', reservePercent: 40, maxSessionWindowPercent: null },
    ]);
  });

  it('skips devin/local-named seats whose seatInfo row is absent', () => {
    const v = view({
      'devin-fake': { enabled: true, reservePercent: 50, maxSessionWindowPercent: 60 },
      'local-fake': { enabled: true, reservePercent: 50, maxSessionWindowPercent: 60 },
      'grok-fake': { enabled: true, reservePercent: 50, maxSessionWindowPercent: 60 },
    });
    expect(automaticReserveSeats(v)).toEqual([
      { seatId: 'grok-fake', reservePercent: 50, maxSessionWindowPercent: 60 },
    ]);
  });

  it('counts a session ceiling under 100 as a restriction but not 100 or absent', () => {
    const v = view({
      'claude-fake': { enabled: true, reservePercent: 0, maxSessionWindowPercent: 70 },
      'codex-fake': { enabled: true, reservePercent: 0, maxSessionWindowPercent: 100 },
      'grok-fake': { enabled: true, reservePercent: 0 },
    });
    expect(automaticReserveSeats(v)).toEqual([
      { seatId: 'claude-fake', reservePercent: 0, maxSessionWindowPercent: 70 },
    ]);
  });

  it('ignores disabled seats even when their policy still shows a reserve', () => {
    const v = view({
      'claude-fake': { enabled: false, reservePercent: 85, maxSessionWindowPercent: 70 },
    });
    expect(automaticReserveSeats(v)).toEqual([]);
  });
});
