import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  betObservation, dayStamp, feedbackLoop, ideaToMerged, isMissing, jobLaneHours, jobTimelines, laneRows, loopMetricValue,
  mergedToInstalled, mergeMorning, morningFields, nodeCapacityRow, parseLedgerTs, percentile, selectionHints, slotLanes,
  throughput, topConstraint, type LoopReport,
} from '../src/core/metrics/loop.js';
import { collectLoop, latestCost, parseMergedPrs, parseReleases, readTail, writeLoop, type LoopReaders } from '../src/core/metrics/loop-collect.js';
import { cmdMetricsLoop } from '../src/cli/metrics-loop.js';
import { cmdMetrics } from '../src/cli/metrics.js';

const T0 = Date.parse('2026-11-16T12:00:00Z');
const iso = (minutesAgo: number) => new Date(T0 - minutesAgo * 60_000).toISOString();
const J = (r: Record<string, unknown>) => JSON.stringify(r);

const LEDGER = [
  J({ event: 'enqueue', job: 'RQ-A', lane: 'claude', tier: 'work', ts: iso(300) }),
  J({ event: 'launch', job: 'RQ-A', lane: 'claude', ts: iso(240) }),
  J({ event: 'finish', job: 'RQ-A', lane: 'claude', wall_s: 3600, ts: iso(180) }),
  J({ event: 'publish', job: 'RQ-A', lane: 'claude', state: 'PUBLISHED', url: 'https://github.com/ashlrai/phantom/pull/101', ts: iso(170) }),
  J({ event: 'outcome', job: 'RQ-A', lane: 'claude', outcome: 'MERGED', url: 'https://github.com/ashlrai/phantom/pull/101', mergedAt: iso(120), ts: iso(119) }),
  J({ event: 'enqueue', job: 'RQ-B', lane: 'codex-personal', tier: 'work', ts: iso(100) }),
  J({ event: 'launch', job: 'RQ-B', lane: 'codex-personal', ts: '2026-11-16T10:40:00+0000' }),
  J({ event: 'finish', job: 'RQ-B', lane: 'codex-personal', ts: '2026-11-16T11:40:00+0000' }),
  J({ event: 'publish', job: 'RQ-B', lane: 'codex-personal', state: 'PUBLISHED', url: 'https://github.com/ashlrai/locus/pull/7/', ts: iso(15) }),
  J({ event: 'outcome', job: 'RQ-B', lane: 'codex-personal', state: 'MERGED', url: 'https://github.com/ashlrai/locus/pull/7', ts: iso(10) }),
  J({ event: 'launch', job: 'RQ-FUTURE', lane: 'devin', ts: iso(-60) }),
  'garbage',
  J({ event: 'launch', lane: 'devin', ts: iso(5) }),
].join('\n');

describe('ledger parsing', () => {
  it('parses dispatchd %z stamps and rejects junk', () => {
    expect(parseLedgerTs('2026-11-16T10:40:00+0000')).toBe(Date.parse('2026-11-16T10:40:00Z'));
    expect(parseLedgerTs('nope')).toBeNull();
    expect(parseLedgerTs(5)).toBeNull();
  });
  it('folds job timelines, ignoring future rows and rows without ids', () => {
    const jobs = jobTimelines(LEDGER, T0);
    expect([...jobs.keys()].sort()).toEqual(['RQ-A', 'RQ-B']);
    const a = jobs.get('RQ-A')!;
    expect(a).toMatchObject({ lane: 'claude', enqueuedAt: T0 - 300 * 60_000, mergedAt: T0 - 120 * 60_000, openedAt: T0 - 170 * 60_000, prUrl: 'https://github.com/ashlrai/phantom/pull/101' });
    expect(jobs.get('RQ-B')!.prUrl).toBe('https://github.com/ashlrai/locus/pull/7');
    expect(jobLaneHours(a)).toBe(1);
    expect(jobLaneHours(jobs.get('RQ-B')!)).toBe(1);
    expect(jobLaneHours({ ...a, wallSeconds: null, finishedAt: null })).toBeNull();
  });
  it('reads the production ledger dialect: jobId/prUrl fields, type/kind events, inferred phases', () => {
    const dialect = [
      // metrics-outcomes-reconciler row copied from a publish row that used jobId/prUrl.
      J({ event: 'publish', jobId: 'RQ-REC', prUrl: 'https://github.com/ashlrai/phantom/pull/55/', outcome: 'MERGED', mergedAt: iso(90), ts: iso(90), source: 'metrics-outcomes-reconciler' }),
      // Eventless phase row: outcome inferred, mergedAt preferred over timestamp.
      J({ job_id: 'RQ-EV', status: 'MERGED', pr: 'https://github.com/ashlrai/phantom/pull/56', timestamp: iso(85), mergedAt: iso(80) }),
      // type/kind event fields, alternate timestamp and arrival spellings, pool lane alias.
      J({ type: 'enqueued', id: 'RQ-T', pool: 'claude', at: iso(200) }),
      J({ kind: 'launch', id: 'RQ-T', lane: 'claude', time: iso(190) }),
      J({ kind: 'finish', id: 'RQ-T', wallS: 600, recordedAt: iso(150) }),
      J({ type: 'published', id: 'RQ-T', url: 'https://github.com/ashlrai/phantom/pull/57', ts: iso(140) }),
      // CLOSED reconciler row: resolved evidence, never an open claim or a merge.
      J({ event: 'publish', job: 'RQ-C', outcome: 'CLOSED', url: 'https://github.com/ashlrai/phantom/pull/58', closedAt: iso(70), ts: iso(70), source: 'metrics-outcomes-reconciler' }),
      // 'merged' event spelling.
      J({ event: 'merged', job: 'RQ-M', ts: iso(60) }),
    ].join('\n');
    const jobs = jobTimelines(dialect, T0);
    expect(jobs.get('RQ-REC')).toMatchObject({ mergedAt: T0 - 90 * 60_000, openedAt: null, prUrl: 'https://github.com/ashlrai/phantom/pull/55' });
    expect(jobs.get('RQ-EV')).toMatchObject({ mergedAt: T0 - 80 * 60_000, openedAt: null, prUrl: 'https://github.com/ashlrai/phantom/pull/56' });
    expect(jobs.get('RQ-T')).toMatchObject({
      lane: 'claude', enqueuedAt: T0 - 200 * 60_000, launchedAt: T0 - 190 * 60_000,
      finishedAt: T0 - 150 * 60_000, wallSeconds: 600, openedAt: T0 - 140 * 60_000,
      mergedAt: null, prUrl: 'https://github.com/ashlrai/phantom/pull/57',
    });
    expect(jobs.get('RQ-C')).toMatchObject({ openedAt: null, mergedAt: null });
    expect(jobs.get('RQ-M')).toMatchObject({ mergedAt: T0 - 60 * 60_000 });
    expect(throughput(jobs, T0)).toMatchObject({ merged_6h: 3, opened_6h: 1 });
  });
  it('percentile interpolates', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([3, 1, 2], 0.5)).toBe(2);
    expect(percentile([0, 10], 0.9)).toBe(9);
  });
});

describe('throughput and loop times', () => {
  const jobs = jobTimelines(LEDGER, T0);
  it('counts merges and opens per hour over 1h and 6h', () => {
    expect(throughput(jobs, T0)).toEqual({ merges_per_hour: { '1h': 1, '6h': 0.33 }, opens_per_hour: { '1h': 1, '6h': 0.33 }, merged_6h: 2, opened_6h: 2 });
  });
  it('measures idea-to-merged from the enqueue row', () => {
    expect(ideaToMerged(jobs, T0)).toEqual({ samples: 2, p50: 135, p90: 171 });
    expect(isMissing(ideaToMerged(new Map(), T0))).toBe(true);
  });
  const releases = [{ tag: 'v3.30.33', createdAt: T0 - 600 * 60_000 }, { tag: 'v3.30.34', createdAt: T0 - 60 * 60_000 }, { tag: 'v3.30.35', createdAt: T0 - 5 * 60_000 }];
  const merges = [{ number: 100, mergedAt: T0 - 700 * 60_000 }, { number: 101, mergedAt: T0 - 120 * 60_000 }, { number: 102, mergedAt: T0 - 30 * 60_000 }];
  it('times merges first shipped by the installed release', () => {
    const m = mergedToInstalled(merges, releases, { version: '3.30.34', installedAt: T0 - 20 * 60_000 });
    expect(m).toMatchObject({ installedTag: 'v3.30.34', perPr: { '101': 100 }, pendingInstall: 1, distribution: { samples: 1, p50: 100 } });
  });
  it('reports missing for unknown installs, unknown versions and the first release', () => {
    expect(mergedToInstalled(merges, releases, null)).toMatchObject({ missing: expect.stringContaining('Info.plist') });
    expect(mergedToInstalled(merges, releases, { version: '9.9.9', installedAt: T0 })).toMatchObject({ missing: expect.stringContaining('9.9.9') });
    expect(mergedToInstalled(merges, releases, { version: '3.30.33', installedAt: T0 })).toMatchObject({ missing: expect.stringContaining('no release before') });
  });
  it('joins idea to installed for PRs in the installed release', () => {
    const m = mergedToInstalled(merges, releases, { version: '3.30.34', installedAt: T0 - 20 * 60_000 });
    expect(feedbackLoop(jobs, m, 'ashlrai/phantom', T0 - 20 * 60_000)).toEqual({ samples: 1, p50: 280, p90: 280 });
    expect(isMissing(feedbackLoop(jobs, m, 'ashlrai/other', T0))).toBe(true);
    expect(isMissing(feedbackLoop(jobs, { missing: 'x' }, 'ashlrai/phantom', T0))).toBe(true);
  });
});

describe('lanes, capacity and hints', () => {
  const jobs = jobTimelines(LEDGER, T0);
  it('reads both slots.json shapes and skips global keys', () => {
    expect(slotLanes({ hard_cap: 10, claude: { target: 8 }, devin: { target: 6, held: true, hard_cap: 3 } }).map(s => s.lane)).toEqual(['claude', 'devin']);
    expect(slotLanes({ lanes: { gemini: { target: 1 } } })).toEqual([{ lane: 'gemini', target: 1, held: false, hardCap: null }]);
    expect(slotLanes('nope')).toEqual([]);
  });
  it('lists every slots lane, measured or missing', () => {
    const rows = laneRows(jobs, slotLanes({ claude: { target: 8 }, grok: { target: 1 } }), { claude: 2 }, T0);
    expect(rows.find(r => r.lane === 'claude')).toMatchObject({ merged_6h: 1, lane_hours_6h: 1, merged_per_lane_hour: 1, running: 2, inSlots: true });
    expect(rows.find(r => r.lane === 'codex-personal')).toMatchObject({ inSlots: false, merged_per_lane_hour: 1 });
    expect(isMissing(rows.find(r => r.lane === 'grok')!.merged_per_lane_hour)).toBe(true);
    expect(rows.find(r => r.lane === 'grok')!.running).toBe(0);
  });
  it('clips lane time to the window', () => {
    const rows = laneRows(jobs, [], null, T0, 3.5);
    expect(rows.find(r => r.lane === 'claude')!.lane_hours_6h).toBe(0.5);
  });
  it('computes spare capacity only from known numbers', () => {
    expect(nodeCapacityRow('n', 'profile', 'ready', 2, 1).spare).toBe(1);
    expect(nodeCapacityRow('n', 'profile', 'ready', 2, 5).spare).toBe(0);
    expect(isMissing(nodeCapacityRow('n', 'profile', 'offline', 2, null).spare)).toBe(true);
  });

  const report = (over: Partial<LoopReport> = {}): LoopReport => ({
    schema: 'metrics.loop.v1', at: iso(0), sources: {},
    throughput: throughput(jobs, T0), idea_to_merged_minutes: ideaToMerged(jobs, T0),
    merged_to_installed_minutes: { missing: 'x' }, feedback_loop_minutes: { missing: 'x' }, cost_per_merged_pr: { usd: 1.5, at: iso(0), source: 's' },
    lanes: laneRows(jobs, slotLanes({ claude: { target: 8 }, grok: { target: 1 }, zai: { target: 0, held: true } }), null, T0),
    capacity_per_node: [nodeCapacityRow('local', 'local', 'dispatcher', 20, 8), nodeCapacityRow('mbp8', 'profile', 'offline', 2, null)],
    resources: [], bets: { launched: 1, kept: 0, killed: 0, active: ['RQ-BET-A'] }, ...over,
  });
  it('maps metric keys to report numbers', () => {
    const r = report();
    expect(loopMetricValue(r, 'merges_per_hour.6h')).toBe(0.33);
    expect(loopMetricValue(r, 'idea_to_merged_minutes.p50')).toBe(135);
    expect(loopMetricValue(r, 'cost_per_merged_pr')).toBe(1.5);
    expect(loopMetricValue(r, 'spare_slots')).toBe(12);
    expect(loopMetricValue(r, 'feedback_loop_minutes.p50')).toBeNull();
    expect(loopMetricValue(r, 'nonsense')).toBeNull();
  });
  it('ranks lanes by merged per lane-hour, held last, and lists nodes with spare', () => {
    const h = selectionHints(report(), { reserved: 2, usable: 1 });
    expect(h.lanes.map(l => l.lane)).toEqual(['claude', 'codex-personal', 'grok', 'zai']);
    expect(h.lanes[2]!.reason).toContain('no finished lane time');
    expect(h.nodes_with_spare).toEqual([{ node: 'local', spare: 12 }]);
    expect(h).toMatchObject({ advisory: true, bets_share: { reserved: 2, usable: 1 }, top_constraint: { name: 'idea-to-merge' } });
    expect(isMissing(selectionHints(report(), null).bets_share)).toBe(true);
  });
  it('names the binding constraint', () => {
    expect(topConstraint(report({ throughput: { missing: 'x' } })).name).toBe('measurement');
    expect(topConstraint(report({ throughput: { merges_per_hour: { '1h': 0, '6h': 0 }, opens_per_hour: { '1h': 1, '6h': 1 }, merged_6h: 0, opened_6h: 6 } })).name).toBe('merge');
    expect(topConstraint(report({ throughput: { merges_per_hour: { '1h': 0, '6h': 0 }, opens_per_hour: { '1h': 0, '6h': 0 }, merged_6h: 0, opened_6h: 0 } })).name).toBe('supply');
    expect(topConstraint(report({ capacity_per_node: [nodeCapacityRow('local', 'local', 'd', 4, 4)] })).name).toBe('capacity');
    expect(topConstraint(report({ merged_to_installed_minutes: { installedVersion: '1.0.0', installedTag: 'v1.0.0', distribution: { samples: 1, p50: 900, p90: 900 }, perPr: {}, pendingInstall: 0 } })).name).toBe('install');
    expect(topConstraint(report({ idea_to_merged_minutes: { missing: 'x' } })).name).toBe('unknown');
  });
  it('builds morning fields and merges them without dropping existing keys', () => {
    const f = morningFields(report());
    expect(f).toMatchObject({ bets: { launched: 1, kept: 0, killed: 0 }, feedback_loop_minutes: { missing: 'x' }, cost_per_merged_pr: 1.5 });
    expect(f.capacity_per_node.local).toEqual({ max: 20, live: 8, spare: 12 });
    expect(mergeMorning({ prior: 1, cost_per_merged_pr: 9 }, f)).toMatchObject({ prior: 1, cost_per_merged_pr: 1.5 });
    expect(mergeMorning(undefined, f)).toMatchObject({ cost_per_merged_pr: 1.5 });
    expect(mergeMorning([1], f)).toBeNull();
    expect(mergeMorning('x', f)).toBeNull();
  });
  it('observes a bet from jobs whose id starts with the bet id', () => {
    const extra = jobTimelines(`${LEDGER}\n${J({ event: 'launch', job: 'RQ-BET-Q-1', lane: 'claude', ts: iso(30) })}\n${J({ event: 'launch', job: 'RQ-BET-Q-2', lane: 'claude', ts: iso(30) })}\n${J({ event: 'finish', job: 'RQ-BET-Q-2', wall_s: 1800, ts: iso(1) })}`, T0);
    expect(betObservation({ id: 'RQ-BET-Q', metric: 'spare_slots' }, extra, report())).toEqual({ value: 12, laneHours: 0.5, merged: 0, jobs: 2 });
    expect(betObservation({ id: 'RQ-BET-NONE', metric: 'spare_slots' }, extra, null)).toEqual({ value: null, laneHours: 0, merged: 0, jobs: 0 });
    const onlyRunning = jobTimelines(J({ event: 'launch', job: 'RQ-BET-R', ts: iso(5) }), T0);
    expect(betObservation({ id: 'RQ-BET-R', metric: 'x' }, onlyRunning, null).laneHours).toBeNull();
  });
  it('stamps the local day', () => {
    expect(dayStamp(new Date(2026, 10, 6, 9))).toBe('20261106');
  });
});

describe('collector readers', () => {
  it('reads the latest cost within 24h only', () => {
    const text = [J({ t: iso(120), costPerMergedPrUsd: 2.5 }), J({ ts: iso(60), costPerMergedPrUsd: 1.234 }), J({ ts: iso(30), costPerMergedPrUsd: null }), J({ ts: iso(2000), costPerMergedPrUsd: 0.1 }), 'bad'].join('\n');
    expect(latestCost(text, T0)).toMatchObject({ usd: 1.23, at: iso(60) });
    expect(latestCost(null, T0)).toMatchObject({ missing: expect.stringContaining('growth-cost-hourly') });
    expect(isMissing(latestCost(J({ ts: iso(2000), costPerMergedPrUsd: 1 }), T0))).toBe(true);
  });
  it('parses gh releases and merged PRs defensively', () => {
    expect(parseReleases(JSON.stringify([{ tag_name: 'v1.0.0', created_at: iso(10) }, { tag_name: 'v1.0.1', draft: true, created_at: iso(5) }, { tag_name: 'v2', prerelease: true, created_at: iso(1) }, 'x'])))
      .toEqual([{ tag: 'v1.0.0', createdAt: T0 - 600_000 }]);
    expect(parseReleases('{}')).toBeNull();
    expect(parseReleases(null)).toBeNull();
    expect(parseMergedPrs(JSON.stringify([{ number: 5, mergedAt: iso(1) }, { number: 'x', mergedAt: iso(1) }]))).toEqual([{ number: 5, mergedAt: T0 - 60_000 }]);
  });
  it('reads a bounded tail without a partial first line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tail-'));
    writeFileSync(join(dir, 'f'), 'aaaa\nbbbb\ncccc\n');
    expect(await readTail(join(dir, 'f'), 7)).toBe('cccc\n');
    expect(await readTail(join(dir, 'f'), 100)).toBe('aaaa\nbbbb\ncccc\n');
    expect(await readTail(join(dir, 'missing'), 10)).toBeNull();
    expect(await readTail(dir, 10)).toBeNull();
  });
});

function fakeReaders(runsDir: string, over: Partial<LoopReaders> = {}): LoopReaders {
  const files: Record<string, string> = {
    'metrics/jobs.jsonl': LEDGER,
    'queue/slots.json': J({ hard_cap: 30, claude: { target: 8 }, 'codex-personal': { target: 20 }, grok: { target: 1 } }),
    'queue/status.json': J({ lanes: { claude: { running: 3 }, 'codex-personal': { running: 5 } } }),
    'queue/ready.tsv': 'RQ-BET-ONE\tphantom\tclaude\twork\t/p\nRQ-X\tphantom\tclaude\tbet:frontier\t/p\nRQ-Y\tphantom\tclaude\twork\t/p\n',
    'queue/concurrency.json': J({ schema: 'dispatchd.concurrency.v1', cap: 24 }),
    'metrics/growth-cost-hourly.jsonl': J({ ts: iso(30), costPerMergedPrUsd: 3 }),
  };
  return {
    runsDir, now: () => T0,
    readText: async (path) => files[path.slice(runsDir.length + 1)] ?? null,
    gh: async (args) => args[0] === 'api'
      ? JSON.stringify([{ tag_name: 'v3.30.33', created_at: iso(600) }, { tag_name: 'v3.30.34', created_at: iso(60) }])
      : JSON.stringify([{ number: 101, mergedAt: iso(120) }]),
    installed: async () => ({ version: '3.30.34', installedAt: T0 - 20 * 60_000 }),
    nodes: () => ({ schema: 'phantom.nodes.v1', generatedAt: iso(0), sourcePath: '/x', observedAt: null, leaderId: null, error: null, nodes: [
      { id: 'mbp8', role: 'worker', owners: [], caps: [], status: 'offline', heartbeatAt: null, heartbeatAgeMs: null, liveJobs: [], ghAuth: 'unknown', leader: false, source: 'profile', profile: { label: 'MBP', ramGb: 8, maxCliAgents: 2, localModels: false, memoryFloorPercent: 15 } },
      { id: 'studio', role: 'leader', owners: [], caps: [], status: 'ready', heartbeatAt: iso(0), heartbeatAgeMs: 0, liveJobs: ['RQ-1'], ghAuth: 'ok', leader: true, source: 'registry' },
    ] }) as never,
    peerTasks: async () => [{ peer: 'dot', state: 'replied', result: { status: 'DONE' } }, { peer: 'dot', state: 'pending' }],
    ncpu: () => 8,
    ...over,
  };
}

describe('collectLoop and writeLoop', () => {
  it('collects every source and lists unmeasurable resources as missing', async () => {
    const runs = mkdtempSync(join(tmpdir(), 'loop-'));
    const c = await collectLoop(fakeReaders(runs));
    const r = c.report;
    expect(r.sources['metrics/jobs.jsonl']).toBe('read');
    expect(r.merged_to_installed_minutes).toMatchObject({ installedTag: 'v3.30.34', distribution: { p50: 100 } });
    expect(r.feedback_loop_minutes).toMatchObject({ p50: 280 });
    expect(r.cost_per_merged_pr).toMatchObject({ usd: 3 });
    expect(r.capacity_per_node[0]).toEqual({ node: 'local', source: 'local', status: 'dispatcher', max: 24, live: 8, spare: 16 });
    expect(isMissing(r.capacity_per_node.find(n => n.node === 'mbp8')!.live)).toBe(true);
    expect(isMissing(r.capacity_per_node.find(n => n.node === 'studio')!.max)).toBe(true);
    expect(r.resources.find(x => x.resource === 'dot')).toMatchObject({ measured: true, detail: { tasks: 2, pending: 1, done: 1, failed: 0 } });
    expect(r.resources.find(x => x.resource === 'instinct')).toMatchObject({ detail: { tasks: 0 } });
    expect(r.resources.find(x => x.resource === 'grok')).toMatchObject({ kind: 'lane', measured: false });
    expect(c.share).toMatchObject({ freeSlots: 16, reserved: 1, readyBetRows: 2, usable: 1 });
    expect(c.hints.lanes[0]!.lane).toBe('claude');
  });
  it('degrades to missing reasons when every reader fails', async () => {
    const runs = mkdtempSync(join(tmpdir(), 'loop-empty-'));
    const c = await collectLoop({ ...fakeReaders(runs), readText: async () => null, gh: async () => null, installed: async () => null, nodes: () => null, peerTasks: async () => null });
    const r = c.report;
    for (const v of [r.throughput, r.idea_to_merged_minutes, r.merged_to_installed_minutes, r.feedback_loop_minutes, r.cost_per_merged_pr]) expect(isMissing(v)).toBe(true);
    expect(r.capacity_per_node).toHaveLength(1);
    expect(isMissing(r.capacity_per_node[0]!.spare)).toBe(true);
    expect(r.resources.filter(x => x.kind === 'peer').every(x => !x.measured)).toBe(true);
    expect(c.share).toMatchObject({ reserved: 0, freeSlots: null });
    expect(c.hints.top_constraint.name).toBe('measurement');
  });
  it('writes loop, hints and share files and merges the morning file', async () => {
    const runs = mkdtempSync(join(tmpdir(), 'loop-write-'));
    const at = new Date(T0);
    const day = dayStamp(at);
    mkdirSync(join(runs, 'reports'), { recursive: true });
    writeFileSync(join(runs, 'reports', `morning-${day}.json`), J({ headline: 'keep me' }));
    const c = await collectLoop(fakeReaders(runs));
    const w = await writeLoop(runs, c, at);
    expect(JSON.parse(readFileSync(w.loop, 'utf8')).schema).toBe('metrics.loop.v1');
    expect(JSON.parse(readFileSync(w.hints, 'utf8')).schema).toBe('metrics.selection-hints.v1');
    expect(JSON.parse(readFileSync(w.share, 'utf8'))).toMatchObject({ schema: 'bets.share.v1', at: iso(0) });
    const morning = JSON.parse(readFileSync(join(runs, 'reports', `morning-${day}.json`), 'utf8'));
    expect(morning).toMatchObject({ headline: 'keep me', cost_per_merged_pr: 3, feedback_loop_minutes: 280, bets: { launched: 0 } });
  });
  it('leaves a corrupt morning file untouched', async () => {
    const runs = mkdtempSync(join(tmpdir(), 'loop-corrupt-'));
    const at = new Date(T0);
    mkdirSync(join(runs, 'reports'), { recursive: true });
    const path = join(runs, 'reports', `morning-${dayStamp(at)}.json`);
    writeFileSync(path, '{broken');
    const w = await writeLoop(runs, await collectLoop(fakeReaders(runs)), at);
    expect(isMissing(w.morning)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('{broken');
    writeFileSync(path, '[1]');
    expect(isMissing((await writeLoop(runs, await collectLoop(fakeReaders(runs)), at)).morning)).toBe(true);
  });
});

describe('phm metrics loop CLI', () => {
  it('prints JSON with --dry-run and writes nothing', async () => {
    const runs = mkdtempSync(join(tmpdir(), 'loop-cli-'));
    const out: string[] = [];
    expect(await cmdMetricsLoop(['--json', '--dry-run'], { out: l => out.push(l), readers: fakeReaders(runs) })).toBe(0);
    const parsed = JSON.parse(out[0]!);
    expect(parsed.writes).toBeNull();
    expect(parsed.report.schema).toBe('metrics.loop.v1');
    expect(existsSync(join(runs, 'metrics'))).toBe(false);
  });
  it('prints a human summary and writes files', async () => {
    const runs = mkdtempSync(join(tmpdir(), 'loop-cli-w-'));
    const out: string[] = [];
    expect(await cmdMetricsLoop([], { out: l => out.push(l), readers: fakeReaders(runs) })).toBe(0);
    expect(out[0]).toContain('Idea to merged p50: 135 min (2 jobs)');
    expect(out[0]).toContain('Cost per merged PR: $3');
    expect(existsSync(join(runs, 'metrics', 'selection-hints.json'))).toBe(true);
  });
  it('rejects unknown flags and prints help', async () => {
    const err: string[] = [], out: string[] = [];
    expect(await cmdMetricsLoop(['--bogus'], { err: l => err.push(l), readers: fakeReaders('/x') })).toBe(2);
    expect(await cmdMetricsLoop(['--json', '--json'], { err: l => err.push(l), readers: fakeReaders('/x') })).toBe(2);
    expect(await cmdMetricsLoop(['--help'], { out: l => out.push(l) })).toBe(0);
    expect(out[0]).toContain('Usage: phm metrics loop');
  });
  it('is routed from phm metrics', async () => {
    const out: string[] = [];
    expect(await cmdMetrics(['loop', '--help'], { out: l => out.push(l), err: () => {} })).toBe(0);
    expect(out[0]).toContain('phm metrics loop');
  });
});
