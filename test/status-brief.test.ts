import { describe, expect, it } from 'vitest';
import { briefText, buildFleetBrief, FLEET_BRIEF_SCHEMA } from '../src/core/fleet/status-brief.js';
import { runway } from '../src/core/usage/runway.js';

const NOW = Date.parse('2026-11-19T00:00:00.000Z');
const metrics = { merged: 31, merged_per_hour: { last_1h: 4, last_6h: 3, last_24h: 1.3, window: 1.3 }, median_publish_to_merge_s: 1500 };

describe('fleet brief', () => {
  it('has the four values, with fixed numbers, as valid JSON', () => {
    const brief = buildFleetBrief({
      metrics,
      guardian: [{ repo: 'a', state: 'green' }, { repo: 'b', state: 'red' }, { repo: 'c', state: 'green' }],
      runway: { pools: [
        runway({ pool: 'slow', usedPercent: 10, burnPerHour: 1, hoursToReset: 50 }),
        runway({ pool: 'fast', usedPercent: 50, burnPerHour: 10, hoursToReset: 20 }),
      ] },
    }, NOW);
    expect(JSON.parse(JSON.stringify(brief))).toEqual({
      schema: FLEET_BRIEF_SCHEMA, v: 1, asOf: '2026-11-19T00:00:00.000Z',
      merged: { lastHour: 4, last24h: 31 }, medianMergeMinutes: 25,
      main: { green: 2, total: 3, red: ['b'] },
      runway: { state: 'known', pool: 'fast', hoursLeft: 5, beforeReset: true },
    });
    const text = briefText(brief);
    expect(text.slice(0, 3)).toEqual(['Merged: 4 in the last hour, 31 in 24 hours.', 'Typical time to merge: 25 min.', 'Main green: 2 of 3 (red: b).']);
    expect(text[3]).toMatch(/^Plan runs out first: fast in 5/);
  });

  it('shows what no source could read as unknown, never zero', () => {
    const brief = buildFleetBrief({ metrics: null, guardian: [], runway: null }, NOW);
    expect(brief.merged).toEqual({ lastHour: null, last24h: null });
    expect(brief.medianMergeMinutes).toBeNull();
    expect(brief.main).toEqual({ green: null, total: null, red: [] });
    expect(brief.runway).toEqual({ state: 'unknown', pool: null, hoursLeft: null, beforeReset: null });
    expect(briefText(brief).join(' ')).toContain('Main green: unknown.');
  });

  it('says steady when plans are read and none is running down', () => {
    const brief = buildFleetBrief({ metrics, guardian: null, runway: { pools: [runway({ pool: 'idle', usedPercent: 10, burnPerHour: 0, hoursToReset: 20 })] } }, NOW);
    expect(brief.runway.state).toBe('steady');
  });
});
