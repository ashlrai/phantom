import { describe, expect, it } from 'vitest';
import { buildLeverageMix, classifyLeverage } from '../src/core/metrics/leverage-mix.js';
import { renderDashboard } from '../src/core/metrics/dashboard.js';
import { cmdMetrics } from '../src/cli/metrics.js';
import { rollup } from '../src/core/metrics/scoring.js';

const fixtures = [
  { paths: ['test/a.test.ts'], job: 'RQ-FIX', expected: 'test-only' },
  { paths: ['src/a.spec.ts', 'test/b.ts'], job: null, expected: 'test-only' },
  { paths: ['docs/guide.md'], job: null, expected: 'docs' },
  { paths: ['README.md', 'test/a.test.ts'], job: null, expected: 'docs' },
  { paths: ['src/app.ts'], job: 'RQ-ADD-PANEL', expected: 'feature' },
  { paths: ['src/app.ts'], job: 'RQ-FEATURE', expected: 'feature' },
  { paths: ['src/core/fleet/digest.ts'], job: null, expected: 'fleet/self-improvement' },
  { paths: ['src/app.ts'], job: 'RQ-QUEUE-IMPROVE', expected: 'fleet/self-improvement' },
  { paths: ['src/app.ts'], job: 'RQ-FIX-BUG', expected: 'fix' },
  { paths: [], job: null, expected: 'unknown' },
] as const;

describe('merged PR leverage mix', () => {
  it('classifies ten representative PRs with explicit precedence', () => {
    for (const fixture of fixtures) expect(classifyLeverage(fixture.paths, fixture.job)).toBe(fixture.expected);
  });
  it('exposes the report through the metrics CLI', () => {
    const output: string[] = [];
    expect(cmdMetrics(['leverage-mix', '--json'], { out: s => output.push(s), err: s => output.push(s) })).toBe(0);
    expect(JSON.parse(output[0]!).schema).toBe('metrics.leverage-mix.v1');
    expect(cmdMetrics(['leverage-mix', '--bad'], { out: () => {}, err: () => {} })).toBe(2);
  });
  it('joins fleet merges to file evidence, includes unknowns and renders the share', () => {
    const now = Date.parse('2026-11-09T12:00:00Z');
    const jobs = fixtures.map((f, i) => JSON.stringify({ event: 'outcome', state: 'MERGED', ts: '2026-11-09T11:00:00Z', url: `https://github.com/ashlrai/phantom/pull/${i + 1}`, job: f.job })).join('\n');
    const prs = JSON.stringify(fixtures.map((f, i) => ({ url: `https://github.com/ashlrai/phantom/pull/${i + 1}`, mergedAt: '2026-11-09T11:00:00Z', files: f.paths })));
    const report = buildLeverageMix(jobs, prs, now);
    expect(report.total).toBe(10);
    expect(report.classes.map(c => c.count)).toEqual([2, 2, 2, 2, 1, 1]);
    expect(report.improvedShare).toBe(0.5);
    const html = renderDashboard(rollup([]), undefined, '2026-11-09T12:00:00Z', report);
    expect(html).toContain('50% of merges are known to have improved the product or fleet');
    expect(html).toContain('Merge mix by class');
    expect(buildLeverageMix(null, prs, now).total).toBeNull();
    expect(buildLeverageMix('', null, now).improvedShare).toBeNull();
    expect(buildLeverageMix(JSON.stringify({ event: 'outcome', state: 'MERGED', ts: '2026-11-09T11:00:00Z', job: 'RQ-OTHER' }), null, now).improvedShare).toBeNull();
  });
});
