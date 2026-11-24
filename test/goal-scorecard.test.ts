import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdGoals } from '../src/cli/goals-view.js';
import {
  buildGoalScorecard, DEFAULT_GOAL_TARGETS, jobsGoalTally, readGoalScorecard, renderGoalScorecard, statusText, trendDirection,
  type FleetGoal, type GoalScorecardInput,
} from '../src/core/fleet/goal-scorecard.js';
import type { FleetMainHealthV1 } from '../src/core/fleet/main-health.js';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const row = (v: Record<string, unknown>) => JSON.stringify(v);

/** 120 merges in 24 h, each published 30 min earlier; 10 jobs launched two days ago, 6 of them merged. */
function busyLines(): string[] {
  const lines: string[] = [];
  for (let i = 0; i < 120; i++) {
    const at = 5 + i * 11; // spread over the last ~22 hours
    lines.push(row({ event: 'publish', job: `RQ-${i}`, ts: ago(at + 30) }));
    lines.push(row({ event: 'outcome', job: `RQ-${i}`, state: 'MERGED', url: `https://github.com/ashlrai/phantom/pull/${i + 1}`, ts: ago(at) }));
  }
  for (let i = 0; i < 10; i++) {
    lines.push(row({ event: 'launch', job: `RQ-L${i}`, ts: ago(48 * 60 + i) }));
    if (i < 6) lines.push(row({ event: 'outcome', job: `RQ-L${i}`, state: 'MERGED', ts: ago(40 * 60 + i) }));
  }
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
const rel = (minutesAgo: number, repo?: string) => row({ publishedAt: ago(minutesAgo), ...(repo ? { repo } : {}) });
const pool = (used: number | null, burn: number | null, resetHours = 48, asOfMinutes = 10) =>
  ({ weekly_used_pct: used, burn_pct_per_hour: burn, reset_at: new Date(NOW + resetHours * 3_600_000).toISOString(), as_of: ago(asOfMinutes) });
const input = (over: Partial<GoalScorecardInput> = {}): GoalScorecardInput => ({
  now: NOW, jobs: tally(busyLines()), status: status({ claude: pool(40, 1.5), codex: pool(10, 0.5) }), mains: mains(['green', 'green']),
  releaseLines: [rel(45, 'ashlrai/phantom'), rel(300, 'ashlrai/locus')], ...over,
});
const byId = (goals: FleetGoal[]) => Object.fromEntries(goals.map(g => [g.id, g]));

describe('buildGoalScorecard', () => {
  it('seeds every goal and marks the healthy ones on track', () => {
    const card = buildGoalScorecard(input());
    // codex is behind (10% + 0.5/h * 48 h = 34%), so it leads; the rest keep their natural order.
    expect(card.goals.map(g => g.id)).toEqual(['pool-codex', 'merges-per-day', 'publish-to-merge', 'launches-merged', 'wasted-launch-rate', 'main-green', 'releases-7d', 'pool-claude']);
    const g = byId(card.goals);
    expect(g['merges-per-day']).toMatchObject({ current: 120, status: 'on-track', statusText: 'on track', target: 96, better: 'higher', source: 'metrics/jobs.jsonl' });
    expect(g['merges-per-day']!.trend24h.points).toHaveLength(24);
    expect(g['merges-per-day']!.trend24h.target).toBe(4);
    expect(g['merges-per-day']!.trend7d.points).toHaveLength(7);
    expect(g['merges-per-day']!.trend7d.points[6]).toBe(120);
    expect(g['publish-to-merge']).toMatchObject({ current: 30, status: 'on-track' });
    expect(g['launches-merged']).toMatchObject({ current: 60, status: 'on-track' });
    expect(g['main-green']).toMatchObject({ current: 2, target: 2, currentText: '2 of 2 repos green', status: 'on-track' });
    expect(g['releases-7d']).toMatchObject({ current: 1, status: 'on-track', updated_at: ago(45), parts: [{ name: 'ashlrai/locus', value: 1 }, { name: 'ashlrai/phantom', value: 1 }] });
    expect(g['releases-7d']!.trend7d).toMatchObject({ points: [0, 0, 0, 0, 0, 0, 2], target: null });
    // 40% + 1.5/h * 48 h = 112% -> capped 100% by reset.
    expect(g['pool-claude']).toMatchObject({ current: 40, status: 'on-track' });
    expect(g['pool-claude']!.currentText).toContain('on pace for 100%');
    expect(g['pool-codex']).toMatchObject({ status: 'behind', statusText: 'behind' });
    expect(card.malformedLines).toBe(0);
  });

  it('marks goals behind when they miss their targets', () => {
    const slow = [
      row({ event: 'publish', job: 'RQ-1', ts: ago(400) }), row({ event: 'outcome', job: 'RQ-1', state: 'MERGED', ts: ago(100) }),
      row({ event: 'launch', job: 'RQ-2', ts: ago(60 * 30) }), row({ event: 'launch', job: 'RQ-3', ts: ago(60 * 30) }),
      row({ event: 'launch', job: 'RQ-1', ts: ago(60 * 26) }),
    ];
    const g = byId(buildGoalScorecard(input({
      jobs: tally(slow), mains: mains(['green', 'red']), releaseLines: [rel(600, 'ashlrai/phantom'), rel(60 * 24 * 9, 'ashlrai/locus')],
      status: status({ codex: pool(10, 0.5) }),
    })).goals);
    expect(g['merges-per-day']).toMatchObject({ current: 1, status: 'behind' });
    expect(g['publish-to-merge']).toMatchObject({ current: 300, status: 'behind' });
    expect(g['launches-merged']).toMatchObject({ current: 33.3, currentText: '33.3% of 3 launches', status: 'behind' });
    expect(g['main-green']).toMatchObject({ current: 1, target: 2, status: 'behind', reason: 'Red: ashlrai/r1.' });
    // locus last released 9 days ago: still expected, now zero this week.
    expect(g['releases-7d']).toMatchObject({ current: 0, status: 'behind', reason: 'Too few releases: ashlrai/locus (0).', parts: [{ name: 'ashlrai/locus', value: 0 }, { name: 'ashlrai/phantom', value: 1 }] });
    // 10% + 0.5/h * 48 h = 34% < 90%: part of the pool would go unused.
    expect(g['pool-codex']).toMatchObject({ status: 'behind' });
  });

  it('shows missing signals as unknown, never as zero', () => {
    const card = buildGoalScorecard({ now: NOW, jobs: null, status: null, mains: null, releaseLines: null });
    expect(card.goals.map(g => g.id)).toEqual(['merges-per-day', 'publish-to-merge', 'launches-merged', 'wasted-launch-rate', 'main-green', 'releases-7d']);
    for (const g of card.goals) {
      expect(g).toMatchObject({ current: null, currentText: 'unknown', status: 'unknown', trend: 'unknown', updated_at: null, parts: [] });
      expect(g.trend24h).toMatchObject({ points: [], direction: 'unknown' });
      expect(g.trend7d).toMatchObject({ points: [], direction: 'unknown' });
      expect(g.statusText).toMatch(/^unknown: [a-z]/);
    }
    expect(byId(card.goals)['merges-per-day']!.statusText).toBe('unknown: the jobs ledger could not be read');
    expect(byId(card.goals)['releases-7d']!.statusText).toBe('unknown: the release log could not be read');
  });

  it('keeps a quiet ledger, stale readings and partial pool rows unknown', () => {
    const g = byId(buildGoalScorecard(input({
      jobs: tally([row({ event: 'launch', job: 'RQ-OLD', ts: ago(60 * 30) })]),
      mains: mains(['green', 'green'], true),
      status: status({ gone: pool(50, 1, -1), old: pool(50, 1, 48, 60 * 7), nopace: pool(50, null), empty: { reset_at: null } }),
    })).goals);
    expect(g['merges-per-day']).toMatchObject({ current: null, status: 'unknown', reason: 'No jobs were recorded in the last 24 hours.' });
    expect(g['merges-per-day']!.trend24h.points).toEqual([]);
    // The ledger was read, so the 7-day line is still drawn: 30 hours ago is the day before.
    expect(g['merges-per-day']!.trend7d.points).toEqual([0, 0, 0, 0, 0, 0, 0]);
    // A quiet last day does not erase a settled launch: 0 of 1 merged is a real 0%.
    expect(g['launches-merged']).toMatchObject({ current: 0, status: 'behind' });
    expect(g['main-green']).toMatchObject({ status: 'unknown', reason: 'The main guardian table is stale.' });
    expect(g['pool-gone']).toMatchObject({ current: 50, status: 'unknown', reason: 'The pool has reset since this reading.' });
    expect(g['pool-old']).toMatchObject({ status: 'unknown', reason: 'The usage reading is old.' });
    expect(g['pool-nopace']).toMatchObject({ status: 'unknown', reason: 'The burn rate is unknown, so the pace is unknown.' });
    expect(g['pool-empty']).toMatchObject({ current: null, currentText: 'unknown', status: 'unknown' });
  });

  it('skips and counts a malformed metrics line without losing the rest', () => {
    const lines = [...busyLines(), '{"event":"outcome","job":"RQ-X","state":"MERGED","ts":', 'not json', row({ event: 'outcome', job: 'RQ-Y', state: 'MERGED', ts: 'yesterday' })];
    const card = buildGoalScorecard(input({ jobs: tally(lines), releaseLines: ['{bad', rel(45)] }));
    expect(card.malformedLines).toBe(4);
    expect(byId(card.goals)['merges-per-day']).toMatchObject({ current: 120, status: 'on-track' });
    expect(byId(card.goals)['releases-7d']).toMatchObject({ current: 1, parts: [{ name: 'repo not recorded', value: 1 }] });
    expect(renderGoalScorecard(card)).toContain('4 unreadable metrics lines were skipped.');
  });

  it('emits stable JSON: same input in any order gives the same bytes and key order', () => {
    const a = buildGoalScorecard(input());
    const b = buildGoalScorecard(input({
      jobs: tally([...busyLines()].reverse()),
      status: status({ codex: pool(10, 0.5), claude: pool(40, 1.5) }),
      releaseLines: [rel(300, 'ashlrai/locus'), rel(45, 'ashlrai/phantom')],
    }));
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(Object.keys(a)).toEqual(['schema', 'version', 'generatedAt', 'malformedLines', 'targets', 'endState', 'goals', 'end_state_text', 'bets', 'bets_source', 'bets_reason', 'as_of']);
    expect(Object.keys(a.goals[0]!)).toEqual(['id', 'title', 'why', 'metric', 'unit', 'target', 'targetText', 'better', 'current', 'currentText',
      'trend', 'trend24h', 'trend7d', 'updated_at', 'source', 'status', 'statusText', 'reason', 'parts', 'evidencePane', 'next']);
    expect(Object.keys(a.goals[0]!.trend24h)).toEqual(['points', 'direction', 'target']);
    expect(a).toMatchObject({ schema: 'fleet.goal-scorecard.v3', version: 3, targets: DEFAULT_GOAL_TARGETS });
  });
});

describe('goal scorecard v2: trends, targets and pools', () => {
  /** n merges spread evenly through day d (0 = the latest 24 h, 6 = six days ago). */
  const mergesOnDay = (d: number, n: number) => Array.from({ length: n }, (_, i) =>
    row({ event: 'outcome', job: `RQ-D${d}-${i}`, state: 'MERGED', url: `https://github.com/ashlrai/phantom/pull/${d * 1000 + i + 1}`,
      ts: ago(d * 24 * 60 + 5 + i * Math.floor((24 * 60) / n)) }));

  it('reads a steady week as flat, a growing week as up and a shrinking week as down', () => {
    const week = (perDay: number[]) => byId(buildGoalScorecard(input({ jobs: tally(perDay.flatMap((n, d) => mergesOnDay(d, n))) })).goals)['merges-per-day']!;
    const flat = week([96, 96, 96, 96, 96, 96, 96]);
    expect(flat.trend7d).toEqual({ points: [96, 96, 96, 96, 96, 96, 96], direction: 'flat', target: 96 });
    expect(flat.trend24h.direction).toBe('flat');
    expect(flat).toMatchObject({ current: 96, trend: 'flat', status: 'on-track' });
    expect(week([96, 96, 96, 48, 24, 24, 24]).trend7d.direction).toBe('up');
    const down = week([24, 24, 24, 48, 96, 96, 96]);
    expect(down.trend7d.direction).toBe('down');
    expect(down).toMatchObject({ current: 24, trend: 'down', status: 'behind' });
  });

  it('takes targets from one typed config with defaults and per-call overrides', () => {
    expect(DEFAULT_GOAL_TARGETS).toEqual({ mergesPerDay: 96, publishToMergeMinutes: 60, launchesMergedPercent: 50, releasesPerRepoPer7d: 1, poolUsedByResetPercent: 90, wastedLaunchRate: 0.2 });
    const card = buildGoalScorecard(input({ targets: { mergesPerDay: 144, releasesPerRepoPer7d: 2 } }));
    const g = byId(card.goals);
    expect(g['merges-per-day']).toMatchObject({ target: 144, targetText: '144 or more a day', status: 'behind' });
    expect(g['releases-7d']).toMatchObject({ target: 2, status: 'behind' });
    expect(card.targets.publishToMergeMinutes).toBe(60);
    expect(card.goals[0]!.status).toBe('behind');
  });

  it('paces included pools only; a pay-per-use lane is not a spend-it goal', () => {
    const ids = buildGoalScorecard(input({ status: status({ claude: pool(40, 1.5), 'claude-api': pool(5, 0.1), local: pool(1, 0) }) })).goals.map(g => g.id);
    expect(ids).toContain('pool-claude');
    expect(ids).not.toContain('pool-claude-api');
    expect(ids).not.toContain('pool-local');
  });

  it('names the repo from repo, repository or a github url', () => {
    const g = byId(buildGoalScorecard(input({ releaseLines: [
      rel(10, 'AshlrAI/Phantom'), row({ publishedAt: ago(20), repository: 'ashlrai/locus' }),
      row({ publishedAt: ago(30), url: 'https://github.com/ashlrai/verse/releases/tag/v1.2.0' }),
    ] })).goals)['releases-7d']!;
    expect(g.parts.map(p => p.name)).toEqual(['ashlrai/locus', 'ashlrai/phantom', 'ashlrai/verse']);
    expect(g.currentText).toBe('3 releases across 3 repos; fewest in one repo: 1');
  });

  it('turns a reason into plain status words', () => {
    expect(statusText('on-track', 'x')).toBe('on track');
    expect(statusText('behind', 'x')).toBe('behind');
    expect(statusText('unknown', 'The usage reading is old.')).toBe('unknown: the usage reading is old');
    expect(statusText('unknown', '')).toBe('unknown: no reading yet');
  });

  it('reads through injected readers without touching disk', async () => {
    const card = await readGoalScorecard({
      runsDir: '/nonexistent/goals-fixture', now: () => NOW,
      readLines: async (_path, onLine) => { for (const line of busyLines()) onLine(line); return true; },
      readStatus: async () => status({ claude: pool(40, 1.5) }),
      readMains: async () => mains(['green']),
      readReleaseLines: async () => [rel(45, 'ashlrai/phantom')],
    });
    expect(card.goals.every(g => g.status === 'on-track')).toBe(true);
    expect(card.goals.map(g => g.id)).toEqual(['merges-per-day', 'publish-to-merge', 'launches-merged', 'wasted-launch-rate', 'main-green', 'releases-7d', 'pool-claude']);
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

  it('prints plain words by default and versioned JSON with --json', async () => {
    const dir = runsDir();
    const out = capture();
    expect(await cmdGoals([], { runsDir: dir, now: () => NOW })).toBe(0);
    expect(out[0]).toContain('PRs merged per day: on track');
    expect(out[0]).toContain('Default branches green: unknown: the main guardian table could not be read');
    expect(out[0]).toContain('Why it matters: A red default branch blocks every merge into that repo.');
    expect(out[0]).toContain('24 h steady · 7 d');
    expect(await cmdGoals(['--json'], { runsDir: dir, now: () => NOW })).toBe(0);
    const card = JSON.parse(out[1]!) as { schema: string; version: number; goals: FleetGoal[] };
    expect(card).toMatchObject({ schema: 'fleet.goal-scorecard.v3', version: 3 });
    expect(byId(card.goals)['merges-per-day']).toMatchObject({ current: 120, status: 'on-track' });
    expect(byId(card.goals)['main-green']).toMatchObject({ status: 'unknown' });
    expect(await cmdGoals(['--text'], { runsDir: dir, now: () => NOW })).toBe(0);
    expect(out[2]).toBe(out[0]);
    expect(await cmdGoals(['--help'])).toBe(0);
    expect(out[3]).toBe('Usage: phm goals [--json]');
  });

  it('reads the same scorecard the route serves and rejects unknown flags', async () => {
    const dir = runsDir();
    const read = await readGoalScorecard({ runsDir: dir, now: () => NOW });
    expect(read.goals).toHaveLength(6);
    capture();
    expect(await cmdGoals(['--bogus'], { runsDir: dir })).toBe(2);
    expect(await cmdGoals(['--json', '--text'], { runsDir: dir })).toBe(2);
  });
});
