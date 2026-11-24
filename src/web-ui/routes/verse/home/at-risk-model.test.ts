import { describe, expect, it } from 'vitest';
import { atRiskReading, burnText, type AtRiskValue } from './at-risk-model.js';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const RISK: AtRiskValue = { resource: 'claude', percentUnused: 50, resetAt: '2026-11-17T22:00:00.000Z', reason: '50.0% will expire unused in 10.0h at current burn.', usedPercent: 40, burnPctPerHour: 1 };
const shares = (risk: AtRiskValue) => atRiskReading(risk, NOW).parts.map(part => [part.kind, part.percent]);

describe('atRiskReading', () => {
  it('splits the window into used now, more by the reset and left over, adding up to the whole', () => {
    const reading = atRiskReading(RISK, NOW);
    expect(reading.figure).toBe('50%');
    expect(shares(RISK)).toEqual([['used', 40], ['more', 10], ['unused', 50]]);
    expect(reading.parts.map(part => part.words)).toEqual(['40% used now', '10% more by its reset at 1% an hour', '50% left over']);
    expect(reading.usedByReset).toBe(50);
    expect(reading.words).toBe('40% used now, 10% more by its reset at 1% an hour, 50% left over');
  });

  it('counts down to the reset and names its local time', () => {
    const reading = atRiskReading(RISK, NOW);
    expect(reading.resetAhead).toBe(true);
    expect(reading.when.startsWith('resets in 10 h · ')).toBe(true);
    expect(atRiskReading({ ...RISK, resetAt: '2026-11-20T12:00:00.000Z' }, NOW).when.startsWith('resets in 3 d · ')).toBe(true);
  });

  it('does not count down to a reset that has passed or cannot be read', () => {
    expect(atRiskReading(RISK, NOW + 11 * 3_600_000)).toMatchObject({ resetAhead: false, when: 'its reset time has passed; waiting for a new reading' });
    expect(atRiskReading({ ...RISK, resetAt: 'soon' }, NOW)).toMatchObject({ resetAhead: false, when: 'reset time unknown' });
  });

  it('draws one used-by-reset share when the summary carries no reading, instead of guessing the split', () => {
    const { usedPercent: _used, burnPctPerHour: _burn, ...bare } = RISK;
    expect(shares(bare)).toEqual([['more', 50], ['unused', 50]]);
    expect(atRiskReading(bare, NOW).words).toBe('50% used by its reset, 50% left over');
    // A reading that is not a number is no reading.
    expect(shares({ ...RISK, usedPercent: Number.NaN })).toEqual([['more', 50], ['unused', 50]]);
  });

  it('says so when nothing more will be used, and leaves the burn out when it was not sent', () => {
    const idle = atRiskReading({ ...RISK, percentUnused: 60, burnPctPerHour: 0 }, NOW);
    expect(idle.parts.map(part => part.words)).toEqual(['40% used now', 'nothing more at the current burn', '60% left over']);
    const { burnPctPerHour: _burn, ...noBurn } = RISK;
    expect(atRiskReading(noBurn, NOW).parts[1]?.words).toBe('10% more by its reset');
  });

  it('keeps the shares inside the bar when the reading and the projection disagree', () => {
    // Used now above what the projection leaves room for: the bar never passes 100.
    expect(shares({ ...RISK, usedPercent: 70 })).toEqual([['used', 50], ['more', 0], ['unused', 50]]);
    expect(shares({ ...RISK, percentUnused: 140, usedPercent: 0 })).toEqual([['used', 0], ['more', 0], ['unused', 100]]);
    const fine = atRiskReading({ ...RISK, percentUnused: 33.3, usedPercent: 50.2 }, NOW);
    expect(fine.parts.reduce((sum, part) => sum + part.percent, 0)).toBeCloseTo(100, 5);
  });

  it('writes a small burn as small, never as zero', () => {
    expect(burnText(0.04)).toBe('<0.1%');
    expect(burnText(0)).toBe('0%');
    expect(burnText(2.36)).toBe('2.4%');
  });
});
