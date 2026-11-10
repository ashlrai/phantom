import { describe, expect, it } from 'vitest';
import { generatorYield } from '../src/core/queue/generator-yield.js';

const now = Date.parse('2026-11-09T12:00:00Z');
const row = (fields: object) => JSON.stringify({ ts: '2026-11-09T10:00:00Z', ...fields });
describe('generator yield', () => {
  it('joins events, groups generators, and counts malformed lines', () => {
    const report = generatorYield([
      row({ job: 'RQ-FOOA123Q8', event: 'launch' }),
      row({ job: 'RQ-FOOA123Q8', event: 'finish', empty: false, tokens_total: 100, diff_lines: 10 }),
      row({ job: 'RQ-FOOA123Q8', event: 'outcome', state: 'MERGED' }),
      row({ job: 'RQ-WORKN9SQ8', event: 'finish', empty: true, tokens_total: 20 }),
      row({ job: 'FIXUP-X', src: 'custom', event: 'finish', empty: false, tokens_total: 30 }),
      row({ job: 'OTHER', event: 'launch' }), '{broken',
    ].join('\n'), 24, now);
    expect(report.malformedLines).toBe(1);
    expect(report.generators).toEqual([
      { generator: 'custom', jobs: 1, prs: 0, merged: 0, emptyRate: 0, medianDiffLines: null, tokensPerMergedPr: null },
      { generator: 'filler', jobs: 1, prs: 1, merged: 1, emptyRate: 0, medianDiffLines: 10, tokensPerMergedPr: 100 },
      { generator: 'leader', jobs: 1, prs: 0, merged: 0, emptyRate: 1, medianDiffLines: null, tokensPerMergedPr: null },
      { generator: 'unknown', jobs: 1, prs: 0, merged: 0, emptyRate: null, medianDiffLines: null, tokensPerMergedPr: null },
    ]);
  });
  it('does not invent token totals and excludes events outside the window', () => {
    const report = generatorYield([row({ job: 'RQ-DRAIN-1', state: 'MERGED' }), row({ job: 'RQ-DRAIN-2', empty: true }), JSON.stringify({ job: 'OLD', ts: '2026-11-01T00:00:00Z' })].join('\n'), 24, now);
    expect(report.generators).toMatchObject([{ generator: 'drain', jobs: 2, merged: 1, tokensPerMergedPr: null }]);
  });
});
