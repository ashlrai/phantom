/**
 * budget-model.original-reserve-242s.test.ts — regression coverage for the
 * reserve-seat classification ported from PR #4828
 * (RQ-PHX-NORESERVEONECLICK111, head 6c5f51f3e06e): `automaticReserveSeats`
 * trusts seatInfo's engine when the seat is listed and falls back to the
 * seat id's devin/local prefix only when it is not. Fixture ids are ordinary
 * ASCII shapes the fleet actually uses (`local:<tag>`, `local-*`, `devin`,
 * `devin-cli`, account ids).
 */
import { describe, expect, it } from 'vitest';
import type { BudgetSeatInfo, BudgetView } from '../../../../core/routing/policy.js';
import type { SeatBudgetPolicy } from '../../../../core/routing/types.js';
import { automaticReserveSeats } from './budget-model.js';

type PolicySpec = { enabled: boolean; reservePercent: number; maxSessionWindowPercent?: number | null };

const restricted = (reservePercent: number, maxSessionWindowPercent?: number | null): PolicySpec =>
  ({ enabled: true, reservePercent, maxSessionWindowPercent });

function seat(seatId: string, engine: BudgetSeatInfo['engine'], free = false): BudgetSeatInfo {
  return { seatId, label: seatId, engine, free };
}

function view(policies: Record<string, PolicySpec>, seatInfo: BudgetSeatInfo[] = []): BudgetView {
  const effective: BudgetView['effective'] = {};
  for (const [seatId, spec] of Object.entries(policies)) {
    const policy: SeatBudgetPolicy = { seatId, enabled: spec.enabled, reservePercent: spec.reservePercent };
    if (spec.maxSessionWindowPercent !== undefined) {
      // Wire JSON can carry an explicit null; the model reads it as "no ceiling".
      (policy as { maxSessionWindowPercent?: number | null }).maxSessionWindowPercent = spec.maxSessionWindowPercent;
    }
    effective[seatId] = policy;
  }
  return {
    mode: 'balanced', seats: {}, updatedAt: '', sampledAt: '', readingMaxAgeMs: 1000, headroom: [],
    seatInfo,
    effective,
  } as BudgetView;
}

describe('automaticReserveSeats (original reserve classification, RQ-242S)', () => {
  it('excludes devin/local-named seats lacking a seatInfo row and keeps listed paid seats', () => {
    const v = view(
      {
        'local-qwen': restricted(50, 60),
        'local:llama3.2:3b': restricted(50, 60),
        'local': restricted(50, 60),
        'LOCAL-QWEN': restricted(50, 60),
        'devin': restricted(50, 60),
        'devin-cli': restricted(50, 60),
        'codex-personal': restricted(50, 60),
        'claude': restricted(40, 70),
        'grok': restricted(0),
      },
      [
        seat('codex-personal', 'codex'),
        seat('claude', 'claude'),
        seat('grok', 'grok'),
      ],
    );
    expect(automaticReserveSeats(v)).toEqual([
      { seatId: 'claude', reservePercent: 40, maxSessionWindowPercent: 70 },
      { seatId: 'codex-personal', reservePercent: 50, maxSessionWindowPercent: 60 },
    ]);
  });

  it('matches the devin/local prefix case-insensitively when seatInfo is absent entirely', () => {
    const v = view({ 'local-qwen': restricted(40), 'Devin-CLI': restricted(40), 'grok-fake': restricted(40) });
    (v as { seatInfo?: BudgetSeatInfo[] }).seatInfo = undefined;
    expect(automaticReserveSeats(v)).toEqual([
      { seatId: 'grok-fake', reservePercent: 40, maxSessionWindowPercent: null },
    ]);
  });

  it('lets seatInfo engine metadata win over a misleading seat id', () => {
    const v = view(
      {
        'local-renamed-claude': restricted(40, 70),
        'devin-renamed-codex': restricted(30, 80),
        'neutral-named-local': restricted(20),
      },
      [
        seat('local-renamed-claude', 'claude'),
        seat('devin-renamed-codex', 'codex'),
        seat('neutral-named-local', 'local', true),
      ],
    );
    expect(automaticReserveSeats(v)).toEqual([
      { seatId: 'devin-renamed-codex', reservePercent: 30, maxSessionWindowPercent: 80 },
      { seatId: 'local-renamed-claude', reservePercent: 40, maxSessionWindowPercent: 70 },
    ]);
  });

  it('counts a reserve above zero or a session ceiling below 100, and nothing else', () => {
    const v = view({
      'claude-fake': restricted(40, 100),
      'codex-fake': restricted(0, 70),
      'grok-fake': restricted(0, 100),
      'zai-fake': restricted(0),
      'agy-fake': restricted(0, null),
    });
    expect(automaticReserveSeats(v)).toEqual([
      { seatId: 'claude-fake', reservePercent: 40, maxSessionWindowPercent: 100 },
      { seatId: 'codex-fake', reservePercent: 0, maxSessionWindowPercent: 70 },
    ]);
  });

  it('keeps restricted seats whose engine name the classifier does not know', () => {
    const v = view({
      'zai-fake': restricted(25, 70),
      'agy-fake': restricted(10),
      'cursor-fake': restricted(5, 90),
    });
    expect(automaticReserveSeats(v)).toEqual([
      { seatId: 'agy-fake', reservePercent: 10, maxSessionWindowPercent: null },
      { seatId: 'cursor-fake', reservePercent: 5, maxSessionWindowPercent: 90 },
      { seatId: 'zai-fake', reservePercent: 25, maxSessionWindowPercent: 70 },
    ]);
  });

  it('ignores disabled seats even when a reserve remains in the policy', () => {
    const v = view({
      'claude-fake': { enabled: false, reservePercent: 85, maxSessionWindowPercent: 50 },
      'local-fake': { enabled: false, reservePercent: 85 },
      'codex-fake': restricted(0, 100),
    });
    expect(automaticReserveSeats(v)).toEqual([]);
  });

  it('returns qualifying seats sorted by seat id regardless of policy order', () => {
    const v = view({
      'zai-fake': restricted(10),
      'claude-fake': restricted(40, 70),
      'agy-fake': restricted(20),
    });
    expect(automaticReserveSeats(v).map((s) => s.seatId)).toEqual(['agy-fake', 'claude-fake', 'zai-fake']);
  });

  it('returns nothing when effective itself is absent', () => {
    const v = view({});
    (v as { effective?: BudgetView['effective'] }).effective = undefined;
    expect(automaticReserveSeats(v)).toEqual([]);
  });
});
