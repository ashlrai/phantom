import { describe, expect, it } from 'vitest';
import { isClaudeSeat, readBudgetRows } from './capacity-strip-model.js';

const RESET = '2026-11-02T12:00:00.000Z';

function budget(seatId: string, engine: 'claude' | 'codex', bindingWindow: 'session' | 'weekly' | null) {
  return {
    seatInfo: [{ seatId, label: seatId, engine, free: false }],
    effective: {},
    headroom: [{
      seatId,
      sessionUsedPercent: 80,
      weeklyUsedPercent: 40,
      bindingWindow,
      autonomyHeadroomPercent: 20,
      resetAt: RESET,
      eligibleForAutonomy: true,
      reasons: [],
    }],
  };
}

describe('Claude capacity headroom', () => {
  it('uses the weekly reading when a retired session window binds', () => {
    const row = readBudgetRows(budget('claude-a', 'claude', 'session')).get('claude-a')!;
    expect(row.headroom).toMatchObject({ sessionUsedPercent: null, weeklyUsedPercent: 40, bindingWindow: 'weekly', resetAt: null });
    expect(row.bars).toEqual([expect.objectContaining({ kind: 'weekly', usedPercent: 40, binding: true })]);
  });

  it('preserves a Codex session reading and binding', () => {
    const row = readBudgetRows(budget('codex-a', 'codex', 'session')).get('codex-a')!;
    expect(row.headroom).toMatchObject({ sessionUsedPercent: 80, weeklyUsedPercent: 40, bindingWindow: 'session', resetAt: RESET });
    expect(row.bars).toContainEqual(expect.objectContaining({ kind: 'session', usedPercent: 80, binding: true }));
  });

  it.each([null, 'weekly'] as const)('preserves a Claude binding of %s', (bindingWindow) => {
    const row = readBudgetRows(budget('claude', 'claude', bindingWindow)).get('claude')!;
    expect(row.headroom).toMatchObject({ sessionUsedPercent: null, weeklyUsedPercent: 40, bindingWindow, resetAt: RESET });
  });

  it('uses the provider field for a Claude seat with a custom ID', () => {
    const row = readBudgetRows(budget('work-account', 'claude', 'session')).get('work-account')!;
    expect(row.headroom).toMatchObject({ sessionUsedPercent: null, weeklyUsedPercent: 40, bindingWindow: 'weekly', resetAt: null });
  });
});

describe('isClaudeSeat', () => {
  it.each([
    ['claude', true],
    ['claude-a', true],
    [' CLAUDE-main ', true],
    ['anthropic', true],
    ['anthropic-a', true],
    ['claude-api', false],
    ['codex-a', false],
    ['claudette', false],
    ['', false],
  ])('identifies %j as Claude subscription: %s', (seatId, expected) => {
    expect(isClaudeSeat(seatId)).toBe(expected);
  });
});
