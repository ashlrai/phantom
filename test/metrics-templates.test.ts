import { describe, expect, it } from 'vitest';
import { cmdMetricsTemplates as cmdMetrics } from '../src/cli/metrics-templates.js';
import { cmdMetrics as dispatchMetrics } from '../src/cli/metrics.js';
import { parseRouterFeed, readRouterFeed, type RouterFeed, type RouterJob } from '../src/core/metrics/router-feed.js';
import { rankTemplates, templateFamily } from '../src/core/metrics/templates.js';

function jobs(prefix: string, outcomes: RouterJob['outcome'][]): RouterJob[] {
  return outcomes.map((outcome, index) => ({ jobId: `${prefix}-${index}`, outcome, tokens: 100,
    ...(outcome === 'merged' ? { impact: { score: 2, version: 'shared-v1' } } : {}) }));
}
const feed = (rows: RouterJob[]): RouterFeed => ({ schemaVersion: 1, available: true, jobs: rows });

describe('template metrics', () => {
  it.each(['RQ-PLAN', 'RQ-FIXUP', 'LAND-RECUT', 'RADAR', 'RQ-PL'])('groups %s families', prefix => {
    expect(templateFamily(`${prefix}-SOME-TASK`)).toBe(`${prefix}-*`);
  });
  it('guards small samples and excludes pending jobs from outcome denominators', () => {
    const report = rankTemplates(feed(jobs('RQ-PLAN', ['empty', 'empty', 'empty', 'empty', 'pending'])));
    expect(report.templates[0]).toMatchObject({ completed: 4, pending: 1, emptyRate: 1, recommendation: 'insufficient-sample' });
    expect(report.rankings.mergeRate).toEqual([]);
  });
  it('flags empty above 30 percent over at least five completed jobs', () => {
    expect(rankTemplates(feed(jobs('RQ-FIXUP', ['empty', 'empty', 'merged', 'failed', 'incomplete']))).templates[0])
      .toMatchObject({ emptyRate: 0.4, incompleteRate: 0.2, recommendation: 'retire-or-rewrite' });
    expect(rankTemplates(feed(jobs('RADAR', Array.from({ length: 10 }, (_, i) => i < 3 ? 'empty' : 'merged')))).templates[0].recommendation).toBe('keep');
  });
  it('does not flag a combined rate exactly at thirty percent', () => {
    const rows = jobs('RADAR', ['empty', 'incomplete', 'incomplete', ...Array<RouterJob['outcome']>(7).fill('merged')]);
    expect(rankTemplates(feed(rows)).templates[0].recommendation).toBe('keep');
  });
  it('ranks merged impact per token ahead of raw merge frequency', () => {
    const low = jobs('RQ-PLAN', Array(5).fill('merged'));
    const high = jobs('RQ-FIXUP', ['merged', 'merged', 'failed', 'failed', 'failed']);
    high[0].impact!.score = 100;
    const report = rankTemplates(feed([...low, ...high]));
    expect(report.rankings.mergedImpactPerToken).toEqual(['RQ-FIXUP-*', 'RQ-PLAN-*']);
    expect(report.rankings.mergeRate).toEqual(['RQ-PLAN-*', 'RQ-FIXUP-*']);
    expect(report).toEqual(rankTemplates(feed([...high, ...low].reverse())));
  });
  it('withholds impact ranking for missing tokens, receipts, mixed versions and zero tokens', () => {
    for (const change of [
      (rows: RouterJob[]) => { delete rows[0].tokens; },
      (rows: RouterJob[]) => { delete rows[0].impact; },
      (rows: RouterJob[]) => { rows[0].impact!.version = 'different'; },
      (rows: RouterJob[]) => { rows.forEach(row => { row.tokens = 0; }); },
    ]) {
      const rows = jobs('RQ-PL', Array(5).fill('merged'));
      change(rows);
      expect(rankTemplates(feed(rows)).rankings.mergedImpactPerToken).toEqual([]);
    }
  });
  it('refuses cross-version impact comparisons between families', () => {
    const rows = jobs('RADAR', Array(5).fill('merged'));
    rows.forEach(row => { row.impact!.version = 'other-version'; });
    expect(rankTemplates(feed([...rows, ...jobs('RQ-PL', Array(5).fill('merged'))])).rankings.mergedImpactPerToken).toEqual([]);
  });
  it('reports pending-only and unavailable feeds without fabricating rates', () => {
    expect(rankTemplates(readRouterFeed())).toMatchObject({ source: 'unavailable', templates: [] });
    expect(rankTemplates(feed(jobs('RADAR', ['pending']))).templates[0]).toMatchObject({ mergeRate: null, emptyRate: null });
  });
  it('rejects malformed input and duplicate jobs', () => {
    for (const value of [null, {}, feed([{ jobId: 'bad/path', outcome: 'merged' }]),
      feed([...jobs('RADAR', ['merged']), ...jobs('RADAR', ['empty'])]),
      feed([{ jobId: 'RADAR-X', outcome: 'merged', tokens: -1 }]),
      feed([{ jobId: 'RADAR-X', outcome: 'merged', impact: { score: NaN, version: '' } }])]) {
      expect(() => parseRouterFeed(value)).toThrow();
    }
  });
  it('prints one JSON document to stdout through the CLI', async () => {
    let output = '';
    const result = await cmdMetrics(['templates', '--json', '--stdin'], {
      readInput: async () => JSON.stringify(feed(jobs('RADAR', ['empty']))),
      write: text => { output += text; },
    });
    expect(result).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ source: 'available', templates: [{ template: 'RADAR-*' }] });
  });
  it('does not read stdin by default or on help and sanitizes errors', async () => {
    let output = '';
    const io = { readInput: async () => { throw new Error('/private/snapshot'); }, write: (text: string) => { output += text; } };
    expect(await cmdMetrics(['templates', '--json'], io)).toBe(0);
    expect(JSON.parse(output).source).toBe('unavailable');
    output = '';
    expect(await cmdMetrics(['templates', '--help'], io)).toBe(0);
    output = '';
    expect(await cmdMetrics(['templates', '--stdin', '--json'], io)).toBe(2);
    expect(JSON.parse(output)).toEqual({ error: 'Invalid router snapshot' });
    output = '';
    expect(await cmdMetrics(['bogus', '--json'], io)).toBe(2);
    expect(JSON.parse(output).error).toContain('Usage:');
  });
  it('dispatches templates through the existing metrics CLI and rejects invalid snapshots', async () => {
    let output = '';
    let input = JSON.stringify(feed(jobs('RADAR', ['empty'])));
    const io = { out: (text: string) => { output += text; }, err: (text: string) => { output += text; }, readInput: async () => input };
    expect(await dispatchMetrics(['--json', 'templates', '--stdin'], io)).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ source: 'available', templates: [{ template: 'RADAR-*' }] });
    output = ''; input = 'private-invalid-snapshot';
    expect(await dispatchMetrics(['templates', '--stdin', '--json'], io)).toBe(2);
    expect(JSON.parse(output)).toEqual({ error: 'Invalid router snapshot' });
  });
});
