import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetPulse } from '../src/cli/fleet-pulse.js';
import { buildPulseLanes, pulseLanesText, PULSE_LANES_SCHEMA, type LaneSlotRead } from '../src/core/fleet/pulse-lanes.js';
import { buildThroughput } from '../src/core/fleet/throughput.js';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const pr = (n: number) => `https://github.com/ashlrai/phantom/pull/${n}`;
const row = (event: string, minutesAgo: number, extra: Record<string, unknown>) => JSON.stringify({ event, ts: at(minutesAgo), ...extra });
/** One fake job: launched, published, merged `toMerge` minutes after publishing, then finished (empty or not). */
const job = (n: number, lane: string, minutesAgo: number, toMerge: number, empty = false) => [
  row('launch', minutesAgo + toMerge + 5, { job: `RQ-FAKE-${n}`, lane, repo: 'phantom' }),
  row('publish', minutesAgo + toMerge, { job: `RQ-FAKE-${n}`, url: pr(n) }),
  row('outcome', minutesAgo, { job: `RQ-FAKE-${n}`, url: pr(n), state: 'MERGED', mergedAt: at(minutesAgo) }),
  row('finish', minutesAgo, { job: `RQ-FAKE-${n}`, lane, empty }),
];
const read = (ledger: string | null) => buildThroughput({ ledger, now: NOW, hours: 24, by: 'lane', metricsPath: 'jobs.jsonl' });
const slots: LaneSlotRead[] = [{ lane: 'claude', running: 2, capacity: 4 }, { lane: 'zai', running: 0, capacity: 3 }, { lane: 'grok', running: 1, capacity: null }];

describe('buildPulseLanes', () => {
  it('a busy window: per lane rates, medians, EMPTY and running of capacity, with totals and 24 hourly values', () => {
    // claude: 12 merged, median 10 min, 3 of 12 finished jobs EMPTY. zai: 2 merged, median 30 min, none EMPTY.
    const ledger = [...Array.from({ length: 12 }, (_, i) => job(i + 1, 'claude', 30 + i * 60, 10, i < 3)).flat(), ...job(21, 'zai', 40, 30).flat(), ...job(22, 'zai', 100, 30).flat()].join('\n');
    const pulse = buildPulseLanes({ throughput: read(ledger), slots }, NOW);
    expect(pulse).toMatchObject({ schema: PULSE_LANES_SCHEMA, v: 1, as_of: at(0), window_h: 24 });
    const claude = pulse.lanes.find(l => l.lane === 'claude')!, zai = pulse.lanes.find(l => l.lane === 'zai')!;
    expect(claude).toMatchObject({ state: 'measured', running: 2, capacity: 4, merged: 12, merged_per_h: 0.5, median_open_to_merge_s: 600, empty_rate: 0.25, finished: 12 });
    expect(zai).toMatchObject({ state: 'measured', running: 0, capacity: 3, merged_per_h: 0.08, median_open_to_merge_s: 1800, empty_rate: 0 });
    expect(pulse.totals).toMatchObject({ running: 3, capacity: 7, merged: 14, merged_per_h: 0.58, empty_rate: 0.214, median_open_to_merge_s: 600 });
    expect(pulse.totals.series.merged_per_h).toHaveLength(24);
    expect(pulse.totals.series.merged_per_h.reduce((a, b) => a + b, 0)).toBe(14);
    expect(pulse.totals.series.empty_rate).toHaveLength(24);
    expect(pulse.headline).toBe('14 PRs merged in the last 24 hours (0.58/h), median 10m 0s to merge, EMPTY 21%, 3 of 7 running.');
    expect(pulseLanesText(pulse)[1]).toMatch(/^ {2}claude: 12 merged \(0\.5\/h\), median 10m 0s to merge, EMPTY 25%, 2 of 4 running$/);
  });

  it('an idle window gives zeros, not errors, and keeps unknown rates unknown', () => {
    const pulse = buildPulseLanes({ throughput: read(''), slots }, NOW);
    expect(pulse.lanes.map(l => [l.lane, l.state, l.merged, l.merged_per_h, l.finished])).toEqual([['claude', 'idle', 0, 0, 0], ['grok', 'idle', 0, 0, 0], ['zai', 'idle', 0, 0, 0]]);
    expect(pulse.lanes[0]).toMatchObject({ empty_rate: null, median_open_to_merge_s: null, running: 2, capacity: 4 });
    expect(pulse.totals).toMatchObject({ merged: 0, merged_per_h: 0, empty_rate: null, running: 3, capacity: 7 });
    expect(pulse.totals.series.merged_per_h).toEqual(Array(24).fill(0));
    expect(pulse.headline).toBe('Quiet: nothing was launched, published or merged in the last 24 hours.');
  });

  it('a lane with no data says "no data yet" while others have data; its numbers stay unknown', () => {
    const pulse = buildPulseLanes({ throughput: read(job(1, 'claude', 30, 10).join('\n')), slots }, NOW);
    expect(pulse.lanes.find(l => l.lane === 'zai')).toEqual({ lane: 'zai', state: 'no_data', running: 0, capacity: 3, merged_per_h: null, median_open_to_merge_s: null, empty_rate: null, merged: null, finished: null, line: 'no data yet' });
    expect(pulse.lanes.find(l => l.lane === 'claude')!.state).toBe('measured');
  });

  it('an unreadable ledger is unknown everywhere, never 0, and running still shows', () => {
    const pulse = buildPulseLanes({ throughput: read(null), slots }, NOW);
    expect(pulse.lanes.every(l => l.state === 'no_data' && l.merged_per_h === null)).toBe(true);
    expect(pulse.totals).toMatchObject({ merged: null, merged_per_h: null, empty_rate: null, running: 3, capacity: 7 });
    expect(pulse.totals.series.merged_per_h).toEqual([]);
    expect(pulse.headline).toBe('Unknown: the job metrics file could not be read.');
    const nothing = buildPulseLanes({ throughput: null, slots: null }, NOW);
    expect(nothing.lanes).toEqual([]);
    expect(nothing.totals).toMatchObject({ running: null, capacity: null, merged_per_h: null });
  });
});

describe('phm fleet pulse --lanes', () => {
  afterEach(() => vi.restoreAllMocks());
  const pulse = buildPulseLanes({ throughput: read(job(1, 'claude', 30, 10).join('\n')), slots }, NOW);
  const run = async (args: string[]) => {
    const out: string[] = [], err: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((text: string) => { out.push(text); });
    vi.spyOn(console, 'error').mockImplementation((text: string) => { err.push(text); });
    const code = await cmdFleetPulse(args, async () => { throw new Error('whole-fleet pulse must not be read'); }, async () => pulse);
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  it('prints typed JSON with a schema id, plain text, and rejects unknown or repeated flags', async () => {
    const json = await run(['--lanes', '--json']);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out)).toMatchObject({ schema: 'fleet.pulse.lanes.v1', v: 1, window_h: 24, lanes: expect.any(Array), totals: { series: expect.any(Object) } });
    expect((await run(['--json', '--lanes'])).out).toBe(json.out);
    const text = await run(['--lanes']);
    expect(text.out).toMatch(/^1 PRs merged in the last 24 hours/);
    expect((await run(['--lanes', '--lanes'])).code).toBe(2);
    expect((await run(['--lanes', '--by'])).code).toBe(2);
    expect((await run(['--help'])).out).toContain('fleet.pulse.lanes.v1');
  });
});
