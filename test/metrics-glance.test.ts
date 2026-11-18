import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cmdMetrics } from '../src/cli/metrics.js';
import { metricsReader, metricsText, readMetrics, type MetricsReader } from '../src/core/fleet/metrics-glance.js';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const DIR = join(process.cwd(), 'test/fixtures/metrics-glance');
/** Fixture sources: one jobs file and a dispatcher status per fleet. */
const fleet = (name: string, edit: (status: Record<string, unknown>) => void = () => {}): MetricsReader => ({
  status: async () => { const status = JSON.parse(await readFile(join(DIR, `${name}.status.json`), 'utf8')) as Record<string, unknown>; edit(status); return status; },
  jobs: () => readFile(join(DIR, 'jobs.jsonl'), 'utf8'),
});
const read = (reader: MetricsReader, hours?: number) => readMetrics({ reader, now: NOW, hours });
const pool = (report: Awaited<ReturnType<typeof read>>, name: string) => report.pools.find(row => row.pool === name);

describe('phm metrics report', () => {
  it('reports a healthy fleet with a stable versioned schema', async () => {
    const report = await read(fleet('healthy'));
    expect(Object.keys(report)).toEqual(['schema', 'version', 'as_of', 'hours', 'sources', 'merged_per_hour', 'merged',
      'median_publish_to_merge_s', 'empty_rate', 'pools_at_risk', 'lanes', 'tiers', 'pools', 'headline']);
    expect(report).toMatchObject({ schema: 'metrics.glance.v1', version: 1, as_of: '2026-11-17T12:00:00.000Z', hours: 24,
      sources: { jobs: 'ok', status: 'ok', status_as_of: '2026-11-17T11:59:30.000Z' },
      merged_per_hour: { last_1h: 2, last_6h: 0.5, last_24h: 0.17, window: 0.17 },
      merged: 4, median_publish_to_merge_s: 270, empty_rate: 0.2, pools_at_risk: 0,
      headline: 'merged per hour 0.17, median merge 4m 30s, empty 20%, pools at risk 0' });
    expect(report.lanes).toEqual([
      { name: 'codex-personal', jobs: 40, merged: 30, empty_rate: 0.1, merge_rate: 0.75, empty_high: false },
      { name: 'claude', jobs: 20, merged: 12, empty_rate: 0.111, merge_rate: 0.667, empty_high: false }]);
    expect(report.tiers?.map(tier => [tier.name, tier.merge_rate])).toEqual([['work', 0.75], ['frontier', 0.667]]);
    expect(pool(report, 'claude')).toEqual({ pool: 'claude', used_pct: 40, hours_to_reset: 24, projected_unused_pct: 0, waste_risk: 'low', at_risk: false, reason: null });
    // A pool the dispatcher does not report stays visible and unknown.
    expect(pool(report, 'gemini')).toMatchObject({ used_pct: null, hours_to_reset: null, projected_unused_pct: null, at_risk: null, reason: 'reading missing' });
    expect(metricsText(report)).toEqual(expect.arrayContaining([
      'Merged per hour: 2 (1 h), 0.5 (6 h), 0.17 (24 h).',
      '  claude: 20 jobs, 12 merged, 11% empty, merge rate 67%',
      'Merge rate by tier: work 75%, frontier 67%.',
      '  claude: 40% used, 24 h to reset, 0% projected unused, waste risk low',
      '  gemini: unknown (reading missing)']));
  });

  it('--hours narrows merge time and empty rate but not the fixed 1, 6 and 24 hour pace', async () => {
    const report = await read(fleet('healthy'), 1);
    expect(report).toMatchObject({ hours: 1, merged: 2, median_publish_to_merge_s: 270, empty_rate: 0.333,
      merged_per_hour: { last_1h: 2, last_6h: 0.5, last_24h: 0.17, window: 2 } });
    expect((await read(fleet('healthy'), 48)).merged_per_hour).toEqual({ last_1h: 2, last_6h: 0.5, last_24h: 0.17, window: 0.08 });
  });

  it('flags a lane that is over half empty and a pool that would go unused', async () => {
    const report = await read(fleet('empty-lane'));
    expect(report.lanes?.find(lane => lane.name === 'devin')).toEqual({ name: 'devin', jobs: 10, merged: 2, empty_rate: 0.6, merge_rate: 0.2, empty_high: true });
    expect(report.lanes?.filter(lane => lane.empty_high).map(lane => lane.name)).toEqual(['devin']);
    expect(report.pools_at_risk).toBe(1);
    expect(pool(report, 'codex-personal')).toEqual({ pool: 'codex-personal', used_pct: 30, hours_to_reset: 10, projected_unused_pct: 50, waste_risk: 'high', at_risk: true, reason: null });
    expect(metricsText(report)).toEqual(expect.arrayContaining([
      '  devin: 10 jobs, 2 merged, 60% empty (over half empty), merge rate 20%',
      '  codex-personal: 30% used, 10 h to reset, 50% projected unused, waste risk high']));
  });

  it('shows a stale budget reading as unknown, never zero', async () => {
    const report = await read(fleet('stale-usage'));
    expect(report.sources.status).toBe('ok');
    expect(report.lanes).toHaveLength(2);
    expect(report.pools_at_risk).toBeNull();
    expect(pool(report, 'claude')).toEqual({ pool: 'claude', used_pct: null, hours_to_reset: null, projected_unused_pct: null, waste_risk: null, at_risk: null, reason: 'reading stale' });
    expect(report.headline).toContain('pools at risk unknown');
    expect(metricsText(report)).toContain('  claude: unknown (reading stale)');
  });

  it('shows lanes, tiers and pools as unknown when the dispatcher stopped ticking', async () => {
    const report = await read(fleet('healthy', status => { status.last_tick = '2026-11-17T11:00:00Z'; }));
    expect(report).toMatchObject({ sources: { jobs: 'ok', status: 'stale', status_as_of: '2026-11-17T11:00:00.000Z' }, lanes: null, tiers: null, pools_at_risk: null, merged: 4 });
    expect(metricsText(report)).toContain('The dispatcher status file is stale (last tick 2026-11-17T11:00:00.000Z), so lanes, tiers and spend-down are unknown.');
  });

  it('reads missing files as unknown through the real reader, and a malformed rollup as unknown values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metrics-glance-'));
    try {
      const report = await read(metricsReader(root));
      expect(report).toMatchObject({ sources: { jobs: 'unreadable', status: 'missing', status_as_of: null }, merged: null, median_publish_to_merge_s: null,
        empty_rate: null, pools_at_risk: null, lanes: null, tiers: null, merged_per_hour: { last_1h: null, last_6h: null, last_24h: null, window: null } });
      expect(report.pools.length).toBeGreaterThan(0);
      expect(report.pools.every(row => row.used_pct === null && row.at_risk === null)).toBe(true);
      expect(JSON.stringify(report)).not.toMatch(/":0[,}]/);
    } finally { await rm(root, { recursive: true, force: true }); }
    const odd = await read(fleet('healthy', status => { status.rollup_24h = { by_lane: { null: { jobs: -1, merged: '3', empty_rate: 7 }, claude: 'x' } }; }));
    expect(odd.lanes).toEqual([{ name: 'unknown', jobs: null, merged: null, empty_rate: null, merge_rate: null, empty_high: null }]);
    expect(odd.tiers).toBeNull();
    expect((await read({ status: () => Promise.reject(new Error('x')), jobs: () => Promise.reject(new Error('x')) })).sources).toMatchObject({ jobs: 'unreadable', status: 'missing' });
  });
});

describe('phm metrics command', () => {
  const run = async (argv: string[], reader: MetricsReader = fleet('healthy')) => {
    const out: string[] = [], err: string[] = [];
    const code = await cmdMetrics(argv, { out: line => out.push(line), err: line => err.push(line), reader, now: () => NOW });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  it('prints plain words by default and the versioned report with --json', async () => {
    const text = await run([]);
    expect(text.code).toBe(0);
    expect(text.out.split('\n')[0]).toBe('Loop health, last 24 hours: merged per hour 0.17, median merge 4m 30s, empty 20%, pools at risk 0.');
    const json = await run(['--json', '--hours', '6']);
    expect(JSON.parse(json.out)).toMatchObject({ schema: 'metrics.glance.v1', version: 1, hours: 6, merged: 3, merged_per_hour: { window: 0.5 } });
  });
  it('refuses a bad window, exits 1 only when no source gives a reading and documents itself', async () => {
    for (const argv of [['--hours'], ['--hours', '0'], ['--hours', '169'], ['--hours', 'x']]) expect((await run(argv)).code).toBe(2);
    const none: MetricsReader = { status: async () => null, jobs: async () => null };
    expect(await run([], none)).toMatchObject({ code: 1, out: expect.stringContaining('Cannot read the job metrics file') });
    expect((await run([], { ...none, jobs: fleet('healthy').jobs })).code).toBe(0);
    expect((await run(['--help'])).out).toContain('Usage: phm metrics [--hours N] [--json]');
  });
});
