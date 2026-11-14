// RQ-PHX-RECUTCORES1C157 — recut of PR #5080 (bridge: RQ-PHX-REDTYPEDESKN1C152).
// `automaticReserveSeats` must never put a Devin seat on the reserve list, even
// when the seatInfo row itself carries `engine: 'devin'` on the wire. The wire
// type (`CapacityEngine` = `Exclude<BudgetEngine, 'devin'>`) cannot express the
// value, so origin/master trusted the row and only filtered on `local`, letting
// a Devin seat through; the recovered code falls back to `engineOfSeatId` and
// refuses both engines outright.
import { describe, expect, it } from 'vitest';
import { automaticReserveSeats } from '../src/web-ui/routes/verse/budget/budget-model.js';

type View = Parameters<typeof automaticReserveSeats>[0];

function policy(reservePercent: number, maxSessionWindowPercent?: number) {
  return {
    seatId: '',
    enabled: true,
    reservePercent,
    ...(maxSessionWindowPercent !== undefined ? { maxSessionWindowPercent } : {}),
  };
}

function viewWith(overrides: Partial<View>): View {
  return {
    mode: 'balanced',
    seats: {},
    effective: {},
    headroom: [],
    seatInfo: [],
    updatedAt: '',
    sampledAt: '',
    readingMaxAgeMs: 1000,
    ...overrides,
  } as View;
}

describe('automaticReserveSeats (recut of #5080)', () => {
  it('skips a seat whose seatInfo row explicitly carries engine devin', () => {
    const view = viewWith({
      seatInfo: [
        { seatId: 'devin-fake', label: 'Devin', engine: 'devin', free: false },
        { seatId: 'codex-fake', label: 'Codex', engine: 'codex', free: false },
      ],
      effective: {
        'devin-fake': policy(40, 70),
        'codex-fake': policy(40, 70),
      },
    });
    expect(automaticReserveSeats(view)).toEqual([
      { seatId: 'codex-fake', reservePercent: 40, maxSessionWindowPercent: 70 },
    ]);
  });

  it('skips a local seat even when its seatInfo row is missing', () => {
    const view = viewWith({
      seatInfo: [
        { seatId: 'claude-fake', label: 'Claude', engine: 'claude', free: false },
      ],
      effective: {
        'local:fake': policy(25),
        'claude-fake': policy(25),
      },
    });
    expect(automaticReserveSeats(view)).toEqual([
      { seatId: 'claude-fake', reservePercent: 25, maxSessionWindowPercent: null },
    ]);
  });
});
