import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdGoals } from '../src/cli/goals-view.js';
import {
  buildGoalScorecard, jobsGoalTally, readGoalScorecard, renderGoalScorecard, trendDirection,
  type FleetGoal, type GoalScorecardInput,
} from '../src/core/fleet/goal-scorecard.js';
import type { FleetMainHealthV1 } from '../src/core/fleet/main-health.js';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const row = (v: Record<string, unknown>) => JSON.stringify(v);

/** 120 merges in 24 h (5/h), each published 30 min earlier; 10 finishes, 1 empty. */
function busyLines(): string[] {
  const lines: string[] = [];
  for (let i = 0; i < 120; i++) {
    const at = 5 + i * 11; // spread over the last ~22 hours
    lines.push(row({ event: 'publish', job: `RQ-${i}`, ts: ago(at + 30) }));
    lines.push(row({ event: 'outcome', job: `RQ-${i}`, state: 'MERGED', url: `https://github.com/ashlrai/phantom/pull/${i + 1}`, ts: ago(at) }));
  }
  for (let i = 0; i < 10; i++) lines.push(row({ event: 'finish', job: `RQ-F${i}`, empty: i === 0, ts: ago(30 + i * 60) }));
  return lines;
}
function tally(lines: readonly string[] | null) {
  const t = jobsGoalTally(NOW);
  for (const line of lines ?? []) t.add(line);
  return t.report(lines !== null);
}
const mains = (states: ('green' | 'red' | 'unknown')[], stale = false): FleetMainHealthV1 => ({
  v: 1, generatedAt: ago(0), source: 'ok', statusAt: ago(5), stale, guardianOff: false, red: states.filter(s => s === 'red').length,
  repos: states.map((state, i) => ({ repo: `ashlrai/r${i}`, branch: 'main', sha: null, state, checkedAt: null, failingCheck: null, fixJobs: [], emptyAttempts: 0, retryHold: false, nightlyRed: null })),
});
const status = (budget: Record<string, unknown>) => ({ last_tick: ago(1), budget });
const pool = (used: number | null, burn: number | null, resetHours = 48, asOfMinutes = 10) =>
  ({ weekly_used_pct: used, burn_pct_per_hour: burn, reset_at: new Date(NOW + resetHours * 3_600_000).toISOString(), as_of: ago(asOfMinutes) });
const input = (over: Partial<GoalScorecardInput> = {}): GoalScorecardInput => ({
  now: NOW, jobs: tally(busyLines()), status: status({ claude: pool(40, 1.5), codex: pool(10, 0.5) }), mains: mains(['green', 'green']),
  releaseLines: [row({ publishedAt: ago(45) }), row({ publishedAt: ago(300) })], ...over,
});
const byId = (goals: FleetGoal[]) => Object.fromEntries(goals.map(g => [g.id, g]));

describe('buildGoalScorecard', () => {
  it('seeds every goal and marks the healthy ones on track', () => {
    const card = buildGoalScorecard(input());
    expect(card.goals.map(g => g.id)).toEqual(['merges-per-hour', 'publish-to-merge', 'empty-finish-rate', 'main-green', 'release-cadence', 'pool-claude', 'pool-codex']);
    const g = byId(card.goals);
    expect(g['merges-per-hour']).toMatchObject({ value: 5, status: 'on-track', source: 'metrics/jobs.jsonl' });
    expect(g['merges-per-hour']!.trend.points).toHaveLength(24);
    expect(g['publish-to-merge']).toMatchObject({ value: 30, status: 'on-track' });
    expect(g['empty-finish-rate']).toMatchObject({ value: 0.1, status: 'on-track' });
    expect(g['main-green']).toMatchObject({ value: 100, valueText: '2 of 2 green', status: 'on-track' });
    expect(g['release-cadence']).toMatchObject({ value: 0.8, status: 'on-track', asOf: ago(45) });
    // 40% + 1.5/h * 48 h = 112% -> capped 100% by reset.
    expect(g['pool-claude']).toMatchObject({ value: 40, status: 'on-track' });
    expect(g['pool-claude']!.valueText).toContain('on pace for 100%');
    expect(card.malformedLines).toBe(0);
  });

  it('marks goals behind when they miss their targets', () => {
    const slow = [
      row({ event: 'publish', job: 'RQ-1', ts: ago(400) }), row({ event: 'outcome', job: 'RQ-1', state: 'MERGED', ts: ago(100) }),
      row({ event: 'finish', job: 'RQ-2', empty: true, ts: ago(50) }), row({ event: 'finish', job: 'RQ-3', empty: false, ts: ago(40) }),
    ];
    const g = byId(buildGoalScorecard(input({
      jobs: tally(slow), mains: mains(['green', 'red']), releaseLines: [row({ publishedAt: ago(600) })],
      status: status({ codex: pool(10, 0.5) }),
    })).goals);
    expect(g['merges-per-hour']).toMatchObject({ value: 0.04, status: 'behind' });
    expect(g['publish-to-merge']).toMatchObject({ value: 300, status: 'behind' });
    expect(g['empty-finish-rate']).toMatchObject({ value: 0.5, status: 'behind' });
    expect(g['main-green']).toMatchObject({ value: 50, status: 'behind', why: 'Red: ashlrai/r1.' });
    expect(g['release-cadence']).toMatchObject({ value: 10, status: 'behind' });
    // 10% + 0.5/h * 48 h = 34% < 90%: part of the pool would go unused.
    expect(g['pool-codex']).toMatchObject({ status: 'behind' });
  });

  it('shows missing signals as unknown, never as zero', () => {
    const card = buildGoalScorecard({ now: NOW, jobs: null, status: null, mains: null, releaseLines: null });
    expect(card.goals.map(g => g.id)).toEqual(['merges-per-hour', 'publish-to-merge', 'empty-finish-rate', 'main-green', 'release-cadence']);
    for (const g of card.goals) {
      expect(g).toMatchObject({ value: null, valueText: 'unknown', status: 'unknown', asOf: null });
      expect(g.trend).toEqual({ points: [], direction: 'unknown' });
      expect(g.why.length).toBeGreaterThan(0);
    }
  });

  it('keeps a quiet ledger, stale readings and partial pool rows unknown', () => {
    const g = byId(buildGoalScorecard(input({
      jobs: tally([row({ event: 'launch', job: 'RQ-OLD', ts: ago(60 * 30) })]),
      mains: mains(['green', 'green'], true),
      status: status({ gone: pool(50, 1, -1), old: pool(50, 1, 48, 60 * 7), nopace: pool(50, null), empty: { reset_at: null } }),
    })).goals);
    expect(g['merges-per-hour']).toMatchObject({ value: null, status: 'unknown', why: 'No jobs were recorded in the last 24 hours.' });
    expect(g['merges-per-hour']!.trend.points).toEqual([]);
    expect(g['main-green']).toMatchObject({ status: 'unknown', why: 'The main guardian table is stale.' });
    expect(g['pool-gone']).toMatchObject({ value: 50, status: 'unknown', why: 'The pool has reset since this reading.' });
    expect(g['pool-old']).toMatchObject({ status: 'unknown', why: 'The usage reading is old.' });
    expect(g['pool-nopace']).toMatchObject({ status: 'unknown', why: 'The burn rate is unknown, so the pace is unknown.' });
    expect(g['pool-empty']).toMatchObject({ value: null, valueText: 'unknown', status: 'unknown' });
  });

  it('skips and counts a malformed metrics line without losing the rest', () => {
    const lines = [...busyLines(), '{"event":"outcome","job":"RQ-X","state":"MERGED","ts":', 'not json', row({ event: 'outcome', job: 'RQ-Y', state: 'MERGED', ts: 'yesterday' })];
    const card = buildGoalScorecard(input({ jobs: tally(lines), releaseLines: ['{bad', row({ publishedAt: ago(45) })] }));
    expect(card.malformedLines).toBe(4);
    expect(byId(card.goals)['merges-per-hour']).toMatchObject({ value: 5, status: 'on-track' });
    expect(byId(card.goals)['release-cadence']).toMatchObject({ value: 0.8 });
    expect(renderGoalScorecard(card)).toContain('4 unreadable metrics lines were skipped.');
  });

  it('emits stable JSON: same input in any order gives the same bytes and key order', () => {
    const a = buildGoalScorecard(input());
    const b = buildGoalScorecard(input({
      jobs: tally([...busyLines()].reverse()),
      status: status({ codex: pool(10, 0.5), claude: pool(40, 1.5) }),
      releaseLines: [row({ publishedAt: ago(300) }), row({ publishedAt: ago(45) })],
    }));
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(Object.keys(a)).toEqual(['schema', 'generatedAt', 'malformedLines', 'goals']);
    expect(Object.keys(a.goals[0]!)).toEqual(['id', 'title', 'target', 'value', 'valueText', 'asOf', 'source', 'trend', 'status', 'why', 'evidencePane']);
    expect(a.schema).toBe('fleet.goal-scorecard.v1');
  });
});

describe('trendDirection', () => {
  it('compares the earlier and later halves, ignoring gaps', () => {
    expect(trendDirection([1, 1, 3, 3])).toBe('up');
    expect(trendDirection([3, null, 1, 1])).toBe('down');
    expect(trendDirection([2, 2, 2, 2.1])).toBe('flat');
    expect(trendDirection([null, null, 1, 2])).toBe('unknown');
    expect(trendDirection([])).toBe('unknown');
  });
});

describe('phm goals', () => {
  const dirs: string[] = [];
  afterEach(() => { vi.restoreAllMocks(); });
  function runsDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'goals-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'metrics'), { recursive: true });
    writeFileSync(join(dir, 'metrics', 'jobs.jsonl'), busyLines().join('\n') + '\n');
    writeFileSync(join(dir, 'metrics', 'growth-releases.jsonl'), row({ publishedAt: ago(45) }) + '\n');
    return dir;
  }
  const capture = () => {
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s: string) => { out.push(s); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    return out;
  };

  it('prints JSON by default and plain words with --text', async () => {
    const dir = runsDir();
    const out = capture();
    expect(await cmdGoals([], { runsDir: dir, now: () => NOW })).toBe(0);
    const card = JSON.parse(out[0]!) as { goals: FleetGoal[] };
    expect(byId(card.goals)['merges-per-hour']).toMatchObject({ value: 5, status: 'on-track' });
    expect(byId(card.goals)['main-green']).toMatchObject({ status: 'unknown' });
    expect(await cmdGoals(['--text'], { runsDir: dir, now: () => NOW })).toBe(0);
    expect(out[1]).toContain('PRs merged per hour: on track');
    expect(out[1]).toContain('Main branch green in every repo: unknown');
  });

  it('reads the same scorecard the route serves and rejects unknown flags', async () => {
    const dir = runsDir();
    const read = await readGoalScorecard({ runsDir: dir, now: () => NOW });
    expect(read.goals).toHaveLength(5);
    capture();
    expect(await cmdGoals(['--bogus'], { runsDir: dir })).toBe(2);
    expect(await cmdGoals(['--json', '--text'], { runsDir: dir })).toBe(2);
  });
});
