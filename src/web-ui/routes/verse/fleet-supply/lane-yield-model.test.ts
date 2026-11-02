import { describe, expect, it } from 'vitest';
import { laneYield, yieldRanking, yieldText } from './lane-yield-model.js';

const lane = (overrides: Record<string, unknown> = {}) => ({
  lane: 'active', tokensLastHour: 41_000, merged24h: 9, mergeRate24h: 0.4,
  running: 2, target: 2, queued: 0, ...overrides,
});

describe('lane yield', () => {
  it('calculates tokens per merge at the sampled rates and formats the line', () => {
    const result = laneYield(lane());
    expect(result).toEqual({ lane: 'active', tokensLastHour: 41_000, merged24h: 9, mergeRate24h: 0.4, tokensPerMerge: 102_500 });
    expect(yieldText(result)).toBe('41k tokens/h · 9 merged in 24 h (0.4/h) · about 100k tokens per merge');
  });

  it('handles missing, zero and invalid values without claiming unknown merges are zero', () => {
    expect(yieldText(laneYield(lane({ merged24h: 0, mergeRate24h: 0 })))).toBe('41k tokens/h · no merges in 24 h');
    expect(yieldText(laneYield(lane({ tokensLastHour: null })))).toBe('tokens unknown · 9 merged in 24 h (0.4/h)');
    expect(yieldText(laneYield(lane({ merged24h: null, mergeRate24h: null })))).toBe('41k tokens/h · merges unknown');
    for (const invalid of [null, undefined, NaN, Infinity, -Infinity, '0.4', 0, -1]) {
      expect(laneYield(lane({ mergeRate24h: invalid })).tokensPerMerge).toBeNull();
    }
    expect(laneYield(lane({ tokensLastHour: Infinity })).tokensPerMerge).toBeNull();
  });

  it('formats small thousands and millions with one decimal', () => {
    expect(yieldText(laneYield(lane({ tokensLastHour: 1_250, mergeRate24h: 1 })))).toContain('1.3k tokens/h');
    expect(yieldText(laneYield(lane({ tokensLastHour: 2_450_000, mergeRate24h: 1 })))).toContain('2.5M tokens/h');
  });

  it('ranks spending with unknown yield first, then worst yield, and excludes idle lanes', () => {
    const rows = [
      lane({ lane: 'best', tokensLastHour: 100, mergeRate24h: 1, queued: 1 }),
      lane({ lane: 'worst', tokensLastHour: 500, mergeRate24h: 1 }),
      lane({ lane: 'zero', tokensLastHour: 0, merged24h: 0, mergeRate24h: 0 }),
      lane({ lane: 'stalled', merged24h: 0, mergeRate24h: 0 }),
      lane({ lane: 'middle', tokensLastHour: 300, mergeRate24h: 1 }),
      lane({ lane: 'other', tokensLastHour: 200, mergeRate24h: 1 }),
    ];
    expect(yieldRanking(rows).map(row => [row.lane, row.hint])).toEqual([
      ['stalled', 'lower the target'], ['worst', 'watch'], ['middle', 'watch'], ['other', 'watch'],
    ]);
    expect(yieldRanking(rows.slice(0, 3)).map(row => [row.lane, row.hint])).toEqual([
      ['worst', 'watch'], ['best', 'raise the target'],
    ]);
    expect(yieldRanking([lane({ merged24h: null, mergeRate24h: null })])[0].hint).toBe('watch');
    expect(yieldRanking([lane({ merged24h: 0, mergeRate24h: 0, running: 1 })])[0].hint).toBe('watch');
  });
});
