import { describe, expect, it } from 'vitest';
import type { StraySlotsV1 } from '../../../../core/fleet/stray-slots.js';
import { strayLine, strayTotals, strayTotalsLine } from './stray-slots-model.js';

const stray = (job: string, pid: number) => ({ job, pid, ageSeconds: 120 });
const report = (lanes: StraySlotsV1['lanes']): StraySlotsV1 => ({
  v: 1, generatedAt: '2026-10-31T12:00:00Z', source: 'ok', lanes,
});

describe('strayLine', () => {
  it('is null while the lane lost no counted slots', () => {
    const data = report([{ lane: 'devin', slotsLost: 0, strays: [] }]);
    expect(strayLine('devin', data)).toBeNull();
    expect(strayLine('missing', data)).toBeNull();
    expect(strayLine('devin', null)).toBeNull();
    expect(strayLine('devin', undefined)).toBeNull();
  });

  it('counts lost slots once per job and names the distinct strays', () => {
    const data = report([{ lane: 'devin', slotsLost: 2, strays: [
      stray('RQ-PHX-ABC', 41), stray('RQ-PHX-ABC', 42), stray('RQ-PHX-DEF', 43),
    ] }]);
    expect(strayLine('devin', data)).toBe('2 slots lost to strays (RQ-PHX-ABC, RQ-PHX-DEF)');
  });

  it('uses the singular form for one slot and caps long job lists', () => {
    const one = report([{ lane: 'devin', slotsLost: 1, strays: [stray('RQ-PHX-ABC', 41)] }]);
    expect(strayLine('devin', one)).toBe('1 slot lost to strays (RQ-PHX-ABC)');
    const many = report([{ lane: 'devin', slotsLost: 6, strays: [1, 2, 3, 4, 5, 6].map(i => stray(`RQ-PHX-${i}`, 40 + i)) }]);
    expect(strayLine('devin', many)).toBe('6 slots lost to strays (RQ-PHX-1, RQ-PHX-2, RQ-PHX-3, RQ-PHX-4 +2 more)');
  });
});

describe('strayTotals', () => {
  it('drops clean lanes, sorts worst first and sums the lost slots', () => {
    const totals = strayTotals(report([
      { lane: 'codex-personal', slotsLost: 1, strays: [stray('RQ-PHX-DEF', 43)] },
      { lane: 'devin', slotsLost: 2, strays: [stray('RQ-PHX-ABC', 41), stray('RQ-PHX-GHI', 42)] },
      { lane: 'clean', slotsLost: 0, strays: [] },
    ]));
    expect(totals).toEqual({ lanes: [{ lane: 'devin', slotsLost: 2 }, { lane: 'codex-personal', slotsLost: 1 }], slotsLost: 3 });
    expect(strayTotals(null)).toEqual({ lanes: [], slotsLost: 0 });
  });
});

describe('strayTotalsLine', () => {
  it('is null when no counted slots are lost', () => {
    expect(strayTotalsLine(strayTotals(report([{ lane: 'devin', slotsLost: 0, strays: [] }])))).toBeNull();
    expect(strayTotalsLine(strayTotals(null))).toBeNull();
  });

  it('names the per-lane breakdown and the listing script', () => {
    const totals = strayTotals(report([
      { lane: 'codex-personal', slotsLost: 1, strays: [stray('RQ-PHX-DEF', 43)] },
      { lane: 'devin', slotsLost: 2, strays: [stray('RQ-PHX-ABC', 41), stray('RQ-PHX-GHI', 42)] },
    ]));
    expect(strayTotalsLine(totals)).toBe(
      '3 counted slots have no worker (devin 2, codex-personal 1). Run leader/STOP-STRAYS.sh to list them.');
  });

  it('uses the singular form for one lost slot', () => {
    const totals = strayTotals(report([{ lane: 'devin', slotsLost: 1, strays: [stray('RQ-PHX-ABC', 41)] }]));
    expect(strayTotalsLine(totals)).toBe('1 counted slot has no worker (devin 1). Run leader/STOP-STRAYS.sh to list them.');
  });
});
