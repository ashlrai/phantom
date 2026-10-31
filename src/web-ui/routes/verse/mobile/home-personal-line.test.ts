import { describe, expect, it } from 'vitest';
import { personalLine } from './home-personal-line.js';

const now = Date.parse('2026-10-31T12:00:00Z');

describe('personalLine', () => {
  it('omits missing or invalid usage without inventing a value', () => {
    for (const runs of [null, {}, { codexPersonal: null }, { codexPersonal: {} }, { codexPersonal: { usedPct: null } }, { codexPersonal: { usedPct: NaN } }]) {
      expect(personalLine(runs, now)).toBeNull();
    }
  });

  it('uses the usage thresholds for the badge tone', () => {
    expect(personalLine({ codexPersonal: { usedPct: 84 } }, now)).toEqual({ title: 'Personal Codex', trailing: '84% used', tone: 'neutral' });
    expect(personalLine({ codexPersonal: { usedPct: 85 } }, now)?.tone).toBe('warning');
    expect(personalLine({ codexPersonal: { usedPct: 92 } }, now)).toEqual({ title: 'Personal Codex', trailing: '92% used', tone: 'warning' });
    expect(personalLine({ codexPersonal: { usedPct: 95 } }, now)?.tone).toBe('danger');
    expect(personalLine({ codexPersonal: { usedPct: 97 } }, now)?.tone).toBe('danger');
  });

  it('formats valid reset times in Eastern time and ignores invalid ones', () => {
    expect(personalLine({ codexPersonal: { usedPct: 92, resetsAt: '2026-11-04T05:41:00Z' } }, now)?.trailing)
      .toBe('92% used · resets Wed 00:41 ET');
    expect(personalLine({ codexPersonal: { usedPct: 92, resetsAt: 'invalid' } }, now)?.trailing).toBe('92% used');
    expect(personalLine({ codexPersonal: { usedPct: 92, resetsAt: '2026-07-07T05:41:00Z' } }, now)?.trailing)
      .toBe('92% used · resets Tue 01:41 ET');
  });
});
