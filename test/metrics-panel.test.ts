import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readMetricsPanel } from '../src/core/fleet/metrics-panel.js';
import { metricsSeriesTally, readMetricsSeries } from '../src/core/fleet/metrics-series.js';

const now = Date.parse('2026-11-17T12:30:00Z'), hour = 3_600_000;
const merge = (ago: number, pr = 1, repo = 'phantom') => ({ event: 'outcome', state: 'MERGED', job: `J${pr}`,
  ts: new Date(now - ago * hour).toISOString(), url: `https://github.com/ashlrai/${repo}/pull/${pr}` });
function build(rows: unknown[]) {
  const tally = metricsSeriesTally(now);
  rows.forEach(row => tally.add(JSON.stringify(row)));
  return tally.report();
}
it('measures empty input as zero and leaves zero-launch ratios unmeasured', () => {
  const series = build([]);
  expect(series).toMatchObject({ known: true, mergesLastHour: 0, mergesLast24h: 0 });
  expect(series.hours).toHaveLength(24);
  expect(series.hours.every(h => h.merged === 0 && h.launches === 0 && h.mergesPerLaunch === null)).toBe(true);
});
it('counts one-hour outcomes by repo without requiring launches or mergedAt', () => {
  const launch = { event: 'launch', job: 'J1', repo: 'phantom', ts: new Date(now - hour / 2).toISOString() };
  const series = build([merge(0.3), merge(0.1, 2, 'locus'), launch, launch]);
  expect(series).toMatchObject({ mergesLastHour: 2, mergesLast24h: 2 });
  expect(series.hours[23]).toMatchObject({ byRepo: { 'ashlrai/phantom': 1, 'ashlrai/locus': 1 }, launches: 1, mergesPerLaunch: 2 });
  expect(series.hours[23]!.end).toBe(new Date(now).toISOString());
});
it('deduplicates PRs across jobs/re-emissions and bounds the rolling window exactly', () => {
  const series = build([merge(0.2), merge(2), { ...merge(1), job: 'another' }, merge(24, 2), merge(25, 3),
    merge(0.5, 3), merge(-0.01, 4), merge(0, 5), merge(1, 6), { ...merge(0.1, 7), state: 'CLOSED' }]);
  expect(series).toMatchObject({ mergesLastHour: 2, mergesLast24h: 4 });
  expect(series.hours[0]!.merged).toBe(1);
  expect(series.hours[22]!.merged).toBe(1);
});
it('accepts reconciler aliases and rejects bad rows without exposing their contents', () => {
  const row = merge(0.1);
  const tally = metricsSeriesTally(now);
  for (const line of ['bad json', 'null', JSON.stringify({ ...row, ts: 'invalid' }), JSON.stringify({
    source: 'metrics-outcomes-reconciler', status: 'MERGED', prUrl: row.url, ts: row.ts,
  })]) tally.add(line);
  expect(tally.report()).toMatchObject({ mergesLastHour: 1, malformedLines: 3 });
});
it('reads launch and merge rows across the jobs-ledger field dialect', () => {
  const series = build([
    { type: 'launch', job_id: 'J1', timestamp: new Date(now - hour / 2).toISOString() },
    { kind: 'outcome', result: 'MERGED', id: 'J1', html_url: 'https://github.com/ashlrai/phantom/pull/9', mergedAt: new Date(now - hour / 4).toISOString() },
    { event: 'publish', outcome: 'MERGED', source: 'metrics-outcomes-reconciler', jobId: 'J2', pr_url: 'https://github.com/ashlrai/phantom/pull/10', ts: new Date(now - hour / 4).toISOString() },
  ]);
  expect(series).toMatchObject({ mergesLastHour: 2, mergesLast24h: 2 });
  expect(series.hours[23]).toMatchObject({ launches: 1, byRepo: { 'ashlrai/phantom': 2 } });
});
it('withholds secret-shaped repo labels while preserving merge counts', () => {
  const repo = 'ghp_' + 'x'.repeat(36);
  const series = build([{ ...merge(0.1), url: undefined, repo }]);
  expect(series.hours[23]!.byRepo).toEqual({ unknown: 1 });
  expect(JSON.stringify(series)).not.toContain(repo);
});
it('discards partial reads on an unreadable source, including thrown reader failures', async () => {
  for (const throws of [false, true]) {
    const result = await readMetricsSeries('/unreadable', now, async (_, onLine) => {
      onLine(JSON.stringify(merge(0.1)));
      if (throws) throw new Error('unreadable');
      return false;
    });
    expect(result).toMatchObject({ known: false, mergesLastHour: null, mergesLast24h: null });
    expect(result.hours.every(h => h.merged === null && h.launches === null && Object.keys(h.byRepo).length === 0)).toBe(true);
  }
});

it('joins the dispatcher rollup to lane capacity and preserves missing readings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'metrics-panel-'));
  try {
    await mkdir(join(root, 'queue'));
    await writeFile(join(root, 'queue', 'status.json'), JSON.stringify({
      last_tick: '2026-11-09T12:00:00Z', paused: false, mem_free_pct: 50,
      lanes: { work: { running: 2, target: 4, queued: 0, held: false }, other: { running: 0, target: 1, queued: 0, held: false } },
      rollup_24h: { by_lane: { work: { merged: 12, median_ttm_s: 120, empty_rate: 0.25 } } },
    }));
    const report = await readMetricsPanel(root);
    expect(report.hourlyMerges).toBeNull();
    expect(report.lanes).toEqual([
      { lane: 'other', mergesPerHour: null, medianOpenToMergeSeconds: null, emptyRate: null, running: 0, target: 1 },
      { lane: 'work', mergesPerHour: 0.5, medianOpenToMergeSeconds: 120, emptyRate: 0.25, running: 2, target: 4 },
    ]);
    await mkdir(join(root, 'metrics'));
    await writeFile(join(root, 'metrics', 'jobs.jsonl'), JSON.stringify(merge(0.1)) + '\n');
    const measured = await readMetricsPanel(root, now);
    expect(measured.series).toMatchObject({ known: true, mergesLastHour: 1, mergesLast24h: 1 });
    expect(measured.hourlyMerges?.at(-1)).toBe(1);
    // The same read also carries the `phm metrics` report; this status has no dispatcher schema or fresh tick, so its lanes stay unknown.
    expect(measured.glance).toMatchObject({ schema: 'metrics.glance.v1', version: 1, sources: { jobs: 'ok', status: 'stale' }, merged_per_hour: { last_1h: 1 }, lanes: null, pools_at_risk: null });
  } finally { await rm(root, { recursive: true, force: true }); }
});
