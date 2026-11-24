import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildLeverageMix, classifyLeverage, readLeverageMix } from '../src/core/metrics/leverage-mix.js';
import { renderDashboard } from '../src/core/metrics/dashboard.js';
import { cmdMetrics } from '../src/cli/metrics.js';
import { rollup } from '../src/core/metrics/scoring.js';
import * as taskCheck from '../src/cli/fleet-task-check.js';

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
  it('exposes the report through the metrics CLI', async () => {
    const output: string[] = [];
    expect(await cmdMetrics(['leverage-mix', '--json'], { out: s => output.push(s), err: s => output.push(s) })).toBe(0);
    expect(JSON.parse(output[0]!).schema).toBe('metrics.leverage-mix.v1');
    expect(await cmdMetrics(['leverage-mix', '--bad'], { out: () => {}, err: () => {} })).toBe(2);
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
  it('reports jobsTruncated only for a bounded tail read', () => {
    const jobs = JSON.stringify({ event: 'outcome', state: 'MERGED', ts: '2026-11-09T11:00:00Z', job: 'RQ-FIX-BUG', url: 'https://github.com/ashlrai/phantom/pull/1' });
    const now = Date.parse('2026-11-09T12:00:00Z');
    expect(buildLeverageMix(jobs, null, now).sources.jobsTruncated).toBe(false);
    expect(buildLeverageMix({ text: jobs, truncated: true }, null, now).sources).toMatchObject({ jobs: 'available', jobsTruncated: true });
    expect(buildLeverageMix(null, null, now).sources.jobsTruncated).toBe(false);
  });
  it('reads the newest bounded tail of an oversized jobs ledger', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'leverage-mix-tail-'));
    mkdirSync(join(dir, 'metrics'));
    const limit = 16 * 1024 * 1024;
    const now = Date.now();
    const recent = JSON.stringify({ event: 'outcome', state: 'MERGED', job: 'RQ-FIX-BUG', ts: new Date(now - 60_000).toISOString(), url: 'https://github.com/ashlrai/phantom/pull/902' });
    writeFileSync(join(dir, 'metrics', 'jobs.jsonl'), 'HEAD-SENTINEL\n' + 'A'.repeat(limit) + '\n' + recent + '\n');
    const report = await readLeverageMix({ runsDir: dir, now });
    expect(report.sources).toMatchObject({ jobs: 'available', jobsTruncated: true });
    expect(report.total).toBe(1);
    expect(report.classes.find(c => c.name === 'fix')?.count).toBe(1);
  });
});

describe('merges metrics CLI', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { ledger: null, known: false, text: 'Merge metrics: unknown' },
    { ledger: '', known: true, text: 'No merges in the last 24 hours' },
    { ledger: 'merged', known: true, text: 'work: 1 merges' },
  ])('reports $text in text and JSON', async ({ ledger, known, text }) => {
    const row = JSON.stringify({ event: 'outcome', state: 'MERGED', job: 'RQ-FIX', lane: 'work', ts: new Date().toISOString() });
    const read = vi.spyOn(taskCheck, 'readTaskCheckJobs').mockResolvedValue(ledger === 'merged' ? row : ledger);
    const io = { out: vi.fn(), err: vi.fn() };
    expect(await cmdMetrics(['merges'], io)).toBe(0);
    expect(io.out).toHaveBeenCalledExactlyOnceWith(text);
    io.out.mockClear();
    expect(await cmdMetrics(['merges', '--json'], io)).toBe(0);
    expect(io.out).toHaveBeenCalledTimes(1);
    const report = JSON.parse(io.out.mock.calls[0]![0]);
    expect(report).toMatchObject({ schema: 'metrics.merges.v1', known, windowHours: 24 });
    expect(report.lanes?.length ?? null).toBe(ledger === null ? null : ledger === '' ? 0 : 1);
    if (ledger === 'merged') expect(report.lanes[0].buckets.reduce((sum: number, bucket: { merges: number }) => sum + bucket.merges, 0)).toBe(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(io.err).not.toHaveBeenCalled();
  });

  it('rejects extra merge arguments before reading the ledger', async () => {
    const read = vi.spyOn(taskCheck, 'readTaskCheckJobs');
    const io = { out: vi.fn(), err: vi.fn() };
    expect(await cmdMetrics(['merges', '--bad'], io)).toBe(2);
    expect(io.err).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('Usage: phm metrics'));
    expect(io.out).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
});
