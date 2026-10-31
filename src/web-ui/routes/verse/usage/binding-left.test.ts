/**
 * binding-left.test.ts covers bindingLeftPercent: the single export
 * from binding-left.ts.  Happy path plus one edge case per behavioural
 * branch; no changes to the source file.
 */
import { describe, expect, it } from 'vitest';
import type { CapacityRow, CapacityWindowRow } from './capacity-strip-model.js';
import { bindingLeftPercent } from './binding-left.js';

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function win(over: Partial<CapacityWindowRow> = {}): CapacityWindowRow {
  return { id: 'w', usedPercent: null, limitReached: false, binding: false, label: '', resetText: null, resetsAt: null, ...over };
}

function row(over: Partial<Pick<CapacityRow, 'quotaCurrent' | 'windows'>> = {}): Pick<CapacityRow, 'quotaCurrent' | 'windows'> {
  return { quotaCurrent: true, windows: [], ...over };
}

/* ------------------------------------------------------------------ */
/* Tests                                                              */
/* ------------------------------------------------------------------ */

describe('bindingLeftPercent', () => {
  it('returns null when quotaCurrent is false (blocked seat)', () => {
    expect(bindingLeftPercent({ quotaCurrent: false, windows: [] })).toBeNull();
  });

  it('returns null when no windows have a reading or a limit flag', () => {
    const r = row({ windows: [win({ usedPercent: null, limitReached: false })] });
    expect(bindingLeftPercent(r)).toBeNull();
  });

  it('happy path: one measured window computes 100 minus usedPercent clamped 0 to 100', () => {
    const r = row({ windows: [win({ usedPercent: 62, binding: true })] });
    expect(bindingLeftPercent(r)).toBe(38);
  });

  it('happy path: picks the highest-used measured window when none is binding', () => {
    const r = row({
      windows: [
        win({ id: 'a', usedPercent: 30 }),
        win({ id: 'b', usedPercent: 85, binding: true }),
        win({ id: 'c', usedPercent: 50 }),
      ],
    });
    expect(bindingLeftPercent(r)).toBe(15);
  });

  it('edge case: binding window flagged limitReached returns 0 (headroom zeroed)', () => {
    const r = row({ windows: [win({ usedPercent: 70, binding: true, limitReached: true })] });
    expect(bindingLeftPercent(r)).toBe(0);
  });

  it('happy path: clamps to 0 when 100 percent used', () => {
    const r = row({ windows: [win({ usedPercent: 100, binding: true })] });
    expect(bindingLeftPercent(r)).toBe(0);
  });

  it('happy path: clamps to 100 when 0 percent used', () => {
    const r = row({ windows: [win({ usedPercent: 0, binding: true })] });
    expect(bindingLeftPercent(r)).toBe(100);
  });
});
