import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cmdFleetLaunches } from '../src/cli/fleet-launches.js';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { buildLaunchRate, gapText, launchRateHours, launchRateText, type LanePlan, type LaunchRateReport } from '../src/core/fleet/launch-rate.js';

const NOW = Date.parse('2026-11-18T20:00:00Z');
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const row = (event: string, minutesAgo: number, extra: Record<string, unknown>) => JSON.stringify({ event, ts: at(minutesAgo), ...extra });
const pr = (n: number) => `https://github.com/ashlrai/phantom/pull/${n}`;
const launch = (job: string, lane: string, minutesAgo: number) => row('launch', minutesAgo, { job, lane });
const merged = (job: string, n: number, minutesAgo: number) => row('outcome', minutesAgo, { job, url: pr(n), state: 'MERGED' });
const build = (lines: string[] | null, plans?: LanePlan[] | null, hours = 24) => buildLaunchRate({ ledger: lines && lines.join('\n'), now: NOW, hours, plans });
const laneOf = (report: LaunchRateReport, name: string) => report.lanes.find(entry => entry.lane === name);

// Even spread: one start an hour, half-past each hour, taking claude and codex in turn; every claude job merges, every other codex job does.
const EVEN = Array.from({ length: 24 }, (_, i) => {
  const lane = i % 2 ? 'codex' : 'claude', job = `RQ-E${i}`, ago = 30 + 60 * i;
  return [launch(job, lane, ago), ...(lane === 'claude' || i % 4 === 1 ? [merged(job, 100 + i, ago - 20)] : [])];
}).flat();

// One zero-yield lane: zai took 12 starts and merged none while claude merged 4 of 8, with 9% of its plan used.
const ZERO_YIELD = [
  ...Array.from({ length: 12 }, (_, i) => launch(`RQ-Z${i}`, 'zai', 20 + 100 * i)),
  ...Array.from({ length: 8 }, (_, i) => launch(`RQ-C${i}`, 'claude', 50 + 150 * i)),
  ...[0, 1, 2, 3].map(i => merged(`RQ-C${i}`, 200 + i, 40 + 150 * i)),
  row('finish', 15, { job: 'RQ-Z0', empty: true }),
];
const PLANS: LanePlan[] = [
  { lane: 'claude', usedFrac: 0.09, resetAt: new Date(NOW + 48 * 3_600_000).toISOString() },
  { lane: 'zai', usedFrac: 0.5, resetAt: null },
];

describe('buildLaunchRate', () => {
  it('reads an even spread: one start an hour, no waste, gaps of an hour', () => {
    const report = build(EVEN);
    expect(report).toMatchObject({ schema: 'fleet.launches.v1', metrics: 'ok', plans: 'unknown', starts: 24, starts_per_hour: 1, wasted_starts: 0 });
    expect(report.longest_gap?.minutes).toBe(60);
    expect(laneOf(report, 'claude')).toMatchObject({ starts: 12, merged: 12, merged_per_start: 1, wasted: false, used_frac: null, reset_hours: null });
    expect(laneOf(report, 'codex')).toMatchObject({ starts: 12, merged: 6, merged_per_start: 0.5, wasted: false });
    expect(report.recommendations).toEqual(['Nothing to change: no lane with 10 or more starts in 24 h merged under 0.1 per start.']);
    expect(report.headline).toBe('24 starts in the last 24 h (1 an hour), 0 wasted, longest gap 1 h');
  });

  it('flags a zero-yield lane and sends its rows to the lane with plan to spare', () => {
    const report = build(ZERO_YIELD, PLANS);
    expect(report).toMatchObject({ starts: 20, wasted_starts: 12, plans: 'ok' });
    expect(laneOf(report, 'zai')).toMatchObject({ starts: 12, merged: 0, merged_per_start: 0, wasted: true, used_frac: 0.5, reset_hours: null });
    expect(laneOf(report, 'claude')).toMatchObject({ starts: 8, merged: 4, merged_per_start: 0.5, wasted: false, used_frac: 0.09, reset_hours: 48 });
    expect(report.recommendations[0]).toBe('zai took 12 of 20 starts in 24 h and merged 0; send its rows to claude (9% used, 48 h left).');
    // Without plan readings the target is still named, with its plan shown as unknown.
    expect(build(ZERO_YIELD).recommendations[0]).toBe('zai took 12 of 20 starts in 24 h and merged 0; send its rows to claude (use unknown, reset unknown).');
  });

  it('does not flag a lane below the 10-start minimum', () => {
    const lines = [...Array.from({ length: 9 }, (_, i) => launch(`RQ-G${i}`, 'grok', 30 + 60 * i)), launch('RQ-K', 'claude', 10), merged('RQ-K', 7, 5)];
    const report = build(lines);
    expect(laneOf(report, 'grok')).toMatchObject({ starts: 9, merged: 0, wasted: false });
    expect(report.wasted_starts).toBe(0);
    expect(report.recommendations.some(line => line.startsWith('grok'))).toBe(false);
  });

  it('finds a long gap between starts and says when it was', () => {
    const lines = [launch('RQ-L1', 'claude', 23 * 60), launch('RQ-L2', 'claude', 22 * 60), launch('RQ-L3', 'claude', 120), launch('RQ-L4', 'claude', 60)];
    const report = build(lines);
    expect(report.longest_gap).toEqual({ from: at(22 * 60), to: at(120), minutes: 1200 });
    expect(report.recommendations).toContain('No job started for 20 h (22:00 UTC to 18:00 UTC); check the dispatcher for that stretch.');
    expect(gapText(130)).toBe('2 h 10 m');
    expect(gapText(45)).toBe('45 m');
  });

  it('reads an empty window as measured zeros, the whole window as the gap', () => {
    const report = build([launch('RQ-OLD', 'claude', 30 * 60), '{torn', '']);
    expect(report).toMatchObject({ metrics: 'ok', starts: 0, starts_per_hour: 0, wasted_starts: 0, longest_gap: { from: at(24 * 60), to: at(0), minutes: 1440 } });
    expect(report.lanes).toEqual([]);
    expect(report.recommendations).toEqual(['No job started in the last 24 h; check that the dispatcher is running.']);
  });

  it('keeps every number unknown when the metrics file is unreadable', () => {
    const report = build(null, PLANS);
    expect(report).toMatchObject({ metrics: 'unreadable', starts: null, starts_per_hour: null, longest_gap: null, wasted_starts: null, lanes: [] });
    expect(report.recommendations).toEqual(['Job metrics could not be read, so starts and merges are unknown.']);
  });

  it('counts a re-emitted merge once and ties a merge found by PR link to its job lane', () => {
    const lines = [
      launch('RQ-M1', 'codex', 300), row('publish', 280, { job: 'RQ-M1', url: pr(9) }),
      row('outcome', 200, { source: 'metrics-outcomes-reconciler', url: pr(9), state: 'MERGED' }),
      row('outcome', 100, { source: 'metrics-outcomes-reconciler', url: pr(9), state: 'MERGED' }),
      // A merge in the window from a job launched before it still belongs to that job's lane.
      launch('RQ-M2', 'claude', 30 * 60), merged('RQ-M2', 10, 60),
    ];
    const report = build(lines, null, 6);
    expect(laneOf(report, 'codex')).toMatchObject({ starts: 1, merged: 1 });
    expect(laneOf(report, 'claude')).toMatchObject({ starts: 0, merged: 1, merged_per_start: null });
  });

  it('suggests more starts for a merging lane with plan to spare and a small share', () => {
    const lines = [...Array.from({ length: 8 }, (_, i) => launch(`RQ-X${i}`, 'codex', 20 + 30 * i)), ...[0, 1, 2, 3].map(i => merged(`RQ-X${i}`, 300 + i, 10)),
      launch('RQ-Y', 'claude', 100), merged('RQ-Y', 400, 50)];
    const report = build(lines, [{ lane: 'claude', usedFrac: 0.2, resetAt: null }], 6);
    expect(report.recommendations).toContain('claude merges and has plan to spare (20% used, reset unknown) but took 1 of 9 starts; give it more.');
  });

  it('validates the window', () => {
    expect([launchRateHours(null), launchRateHours('6'), launchRateHours('168')]).toEqual([24, 6, 168]);
    for (const bad of ['0', '169', '1.5', '6h', '']) expect(launchRateHours(bad)).toBeNull();
  });

  it('writes plain lines: headline, changes, then lanes', () => {
    const lines = launchRateText(build(ZERO_YIELD, PLANS));
    expect(lines[0]).toBe('20 starts in the last 24 h (0.8 an hour), 12 wasted, longest gap 5 h 20 m.');
    expect(lines[1]).toMatch(/^- zai took 12 of 20 starts/);
    expect(lines).toContain('  zai: 12 starts, 0 merged (0 per start); 24 h 12 starts, 0 merged (0 per start), WASTED; plan 50% used, reset unknown');
  });
});

describe('phm fleet launches and its route', () => {
  let runs: string;
  beforeAll(async () => {
    runs = await mkdtemp(join(tmpdir(), 'launches-'));
    await mkdir(join(runs, 'metrics'), { recursive: true });
    await mkdir(join(runs, 'queue'), { recursive: true });
    await writeFile(join(runs, 'metrics', 'jobs.jsonl'), ZERO_YIELD.join('\n'));
    await writeFile(join(runs, 'queue', 'slots.json'), JSON.stringify({ claude: { target: 8 }, zai: { target: 3 } }));
    await writeFile(join(runs, 'queue', 'resources.json'), JSON.stringify({ claude: { used_frac: 0.09, reset_at: PLANS[0]!.resetAt }, zai: { used_frac: 0.5 } }));
  });
  afterAll(() => rm(runs, { recursive: true, force: true }));
  async function run(...args: string[]): Promise<{ code: number; out: string; err: string }> {
    const out: string[] = [], err: string[] = [];
    const code = await cmdFleetLaunches(args, { now: () => NOW, out: line => out.push(line), err: line => err.push(line) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  it('prints the JSON shape agents read', async () => {
    const { code, out } = await run('--runs-dir', runs, '--json');
    expect(code).toBe(0);
    const report = JSON.parse(out) as LaunchRateReport;
    expect(Object.keys(report)).toEqual(['schema', 'as_of', 'hours', 'metrics', 'plans', 'waste_rule', 'starts', 'starts_per_hour', 'longest_gap', 'wasted_starts', 'lanes', 'relaunches', 'repeat_jobs', 'headline', 'recommendations']);
    expect(report).toMatchObject({ schema: 'fleet.launches.v1', hours: 24, metrics: 'ok', plans: 'ok', waste_rule: { merged_per_start_under: 0.1, min_starts_24h: 10 }, starts: 20, wasted_starts: 12 });
    expect(Object.keys(report.lanes[0]!)).toEqual(['lane', 'starts', 'merged', 'merged_per_start', 'starts_24h', 'merged_24h', 'merged_per_start_24h', 'starts_per_merged_pr', 'wasted', 'used_frac', 'reset_hours']);
    expect(report.repeat_jobs).toEqual([]);
    expect(report.relaunches['RQ-C0']?.launches).toBe(1);
    expect(laneOf(report, 'claude')?.starts_per_merged_pr).toBe(2);
    expect(laneOf(report, 'zai')?.starts_per_merged_pr).toBeNull();
    expect(Object.keys(report.longest_gap!)).toEqual(['from', 'to', 'minutes']);
    expect(report.recommendations[0]).toBe('zai took 12 of 20 starts in 24 h and merged 0; send its rows to claude (9% used, 48 h left).');
    const text = await run('--runs-dir', runs, '--hours', '6');
    expect(text.out.split('\n')[0]).toMatch(/^\d+ starts in the last 6 h \(/);
  });

  it('exits 1 with unknowns on an unreadable file and 2 on a bad option', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'launches-none-'));
    try {
      const missing = await run('--runs-dir', empty, '--json');
      expect(missing.code).toBe(1);
      expect(JSON.parse(missing.out)).toMatchObject({ metrics: 'unreadable', plans: 'unknown', starts: null });
    } finally { await rm(empty, { recursive: true, force: true }); }
    for (const args of [['--hours', '0'], ['--hours'], ['--since', '24h'], ['--hours', '2', '--hours', '3']]) {
      const bad = await run(...args);
      expect([bad.code, bad.out]).toEqual([2, '']);
      expect(bad.err).toContain('Usage: phm fleet launches');
    }
    expect((await run('--help')).out).toContain('Usage: phm fleet launches');
  });

  it('serves the same report on the fleet runs route', async () => {
    const api = createFleetRunsApi({ runsDir: runs, now: () => NOW });
    const path = '/api/verse/fleet/runs/launches';
    const call = async (query: string, method = 'GET') => {
      const req = Readable.from([]) as unknown as IncomingMessage;
      req.url = path + query; req.method = method; req.headers = {};
      let status = 0, body: unknown = null;
      const res = { headersSent: false, writeHead(code: number) { status = code; }, end(text: string) { body = JSON.parse(text); } } as unknown as ServerResponse;
      expect(await api({ cfg: {}, token: 'fake', allowDispatch: false } as VerseApiContext, req, res, path, method)).toBe(true);
      return { status, body };
    };
    const cli = JSON.parse((await run('--runs-dir', runs, '--hours', '6', '--json')).out) as LaunchRateReport;
    expect(await call('?hours=6')).toEqual({ status: 200, body: cli });
    expect((await call('')).body).toMatchObject({ hours: 24, starts: 20, wasted_starts: 12 });
    expect((await call('?hours=999')).status).toBe(400);
    expect((await call('', 'POST')).status).toBe(405);
  });
});
