/**
 * The Goals view's model (RQ-GOALSVIEWN19LQ8): the five goals Mason named,
 * each computed from fixture fleet data (never typed in), missing data as
 * unknown (never 0), the trend direction, and the `phm goals --json` shape
 * agents read. Hermetic: fixtures and temp dirs only.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdGoals } from '../src/cli/goals-view.js';
import {
  buildGoalScorecard, jobsGoalTally, renderGoalScorecard, TREND_MARK,
  type FleetGoal, type GoalScorecard, type GoalScorecardInput,
} from '../src/core/fleet/goal-scorecard.js';
import type { FleetMainHealthV1 } from '../src/core/fleet/main-health.js';

const NOW = Date.parse('2026-11-18T12:00:00Z');
const HOUR_MIN = 60;
const DAY_MIN = 24 * HOUR_MIN;
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const row = (v: Record<string, unknown>) => JSON.stringify(v);
const merged = (job: string, minutesAgo: number, pr: number) =>
  row({ event: 'outcome', job, state: 'MERGED', url: `https://github.com/ashlr/app/pull/${pr}`, ts: ago(minutesAgo) });

function tally(lines: readonly string[]) {
  const t = jobsGoalTally(NOW);
  for (const line of lines) t.add(line);
  return t.report(true);
}
const mains = (states: ('green' | 'red' | 'unknown')[]): FleetMainHealthV1 => ({
  v: 1, generatedAt: ago(0), source: 'ok', statusAt: ago(3), stale: false, guardianOff: false, red: states.filter(s => s === 'red').length,
  repos: states.map((state, i) => ({ repo: `ashlr/r${i}`, branch: 'main', sha: null, state, checkedAt: null, failingCheck: null, fixJobs: [], emptyAttempts: 0, retryHold: false, nightlyRed: null })),
});
const NONE: GoalScorecardInput = { now: NOW, jobs: null, status: null, mains: null, releaseLines: null };
const goalsOf = (input: Partial<GoalScorecardInput>): Record<string, FleetGoal> =>
  Object.fromEntries(buildGoalScorecard({ ...NONE, ...input }).goals.map(g => [g.id, g]));
const FIVE = ['merges-per-day', 'publish-to-merge', 'launches-merged', 'wasted-launch-rate', 'main-green'] as const;

describe('each goal is computed from fleet data', () => {
  it('PRs merged per day counts distinct merged PRs in the last 24 hours', () => {
    const lines = [
      ...Array.from({ length: 100 }, (_, i) => merged(`J${i}`, 10 + i * 10, i + 1)),
      merged('J0', 5, 1), // the same PR again: counted once
      merged('OLD', DAY_MIN + 30, 999), // yesterday: not today's count
    ];
    const g = goalsOf({ jobs: tally(lines) })['merges-per-day']!;
    expect(g).toMatchObject({ current: 100, unit: 'PRs a day', target: 96, status: 'on-track', source: 'metrics/jobs.jsonl' });
    expect(g.currentText).toBe('100 in the last 24 hours');
  });

  it('time from PR opened to merged is the median minutes over the last 24 hours', () => {
    const lines = [10, 20, 90].flatMap((minutes, i) => [
      row({ event: 'publish', job: `P${i}`, ts: ago(60 + minutes) }), merged(`P${i}`, 60, i + 1),
    ]);
    const g = goalsOf({ jobs: tally(lines) })['publish-to-merge']!;
    expect(g).toMatchObject({ current: 20, unit: 'minutes', target: 60, better: 'lower', status: 'on-track' });
  });

  it('launches that merge count only settled launches (1 to 8 days old)', () => {
    const lines = [
      ...['A', 'B', 'C', 'D'].map((job, i) => row({ event: 'launch', job, ts: ago(2 * DAY_MIN + i) })),
      merged('A', DAY_MIN + 60, 1),
      row({ event: 'launch', job: 'FRESH', ts: ago(30) }), // may still merge: not judged
      row({ event: 'launch', job: 'ANCIENT', ts: ago(9 * DAY_MIN) }), // outside the window
      row({ event: 'launch', job: 'A', ts: ago(DAY_MIN + 90) }), // a retry under the same id is one launch
    ];
    const g = goalsOf({ jobs: tally(lines) })['launches-merged']!;
    expect(g).toMatchObject({ current: 25, unit: '%', target: 50, status: 'behind', currentText: '25% of 4 launches' });
  });

  it('default branches green is a count of repos against every repo', () => {
    const g = goalsOf({ mains: mains(['green', 'green', 'red']) })['main-green']!;
    expect(g).toMatchObject({ current: 2, target: 3, unit: 'repos', status: 'behind', reason: 'Red: ashlr/r2.' });
    expect(goalsOf({ mains: mains(['green', 'green']) })['main-green']).toMatchObject({ current: 2, target: 2, status: 'on-track' });
  });

  it("each included plan's pool is the share used, judged on pace to its reset", () => {
    const status = { last_tick: ago(1), budget: {
      claude: { weekly_used_pct: 70, burn_pct_per_hour: 1, reset_at: new Date(NOW + 24 * 3_600_000).toISOString(), as_of: ago(5) },
      codex: { weekly_used_pct: 20, burn_pct_per_hour: 0.1, reset_at: new Date(NOW + 24 * 3_600_000).toISOString(), as_of: ago(5) },
    } };
    const g = goalsOf({ status });
    expect(g['pool-claude']).toMatchObject({ current: 70, unit: '%', target: 90, status: 'on-track', source: 'queue/status.json' });
    expect(g['pool-claude']!.currentText).toContain('on pace for 94%');
    expect(g['pool-codex']).toMatchObject({ current: 20, status: 'behind' });
  });

  it('every goal says why it matters in one plain sentence and names what it measures', () => {
    const card = buildGoalScorecard(NONE);
    for (const g of card.goals) {
      expect(g.why).toMatch(/^[A-Z][^.]*\.$/);
      expect(g.metric.length).toBeGreaterThan(0);
      expect(g.unit.length).toBeGreaterThan(0);
    }
  });
});

describe('missing data is unknown, never 0', () => {
  it('shows every goal unknown with a reason when nothing can be read', () => {
    const card = buildGoalScorecard(NONE);
    expect(card.goals.map(g => g.id)).toEqual([...FIVE, 'releases-7d']);
    for (const g of card.goals) {
      expect(g.current).toBeNull();
      expect(g.currentText).toBe('unknown');
      expect(g).toMatchObject({ status: 'unknown', trend: 'unknown', updated_at: null });
      expect(g.statusText).toMatch(/^unknown: /);
    }
    expect(goalsOf({})['main-green']!.target).toBeNull();
    const text = renderGoalScorecard(card);
    expect(text).not.toMatch(/Now 0\b/);
    expect(text).toContain(`Now unknown ${TREND_MARK.unknown}`);
  });

  it('keeps an empty launch cohort and a pool with no reading unknown', () => {
    const g = goalsOf({
      jobs: tally([row({ event: 'launch', job: 'FRESH', ts: ago(30) })]),
      status: { last_tick: ago(1), budget: { claude: { reset_at: new Date(NOW + 3_600_000).toISOString() } } },
    });
    expect(g['launches-merged']).toMatchObject({ current: null, status: 'unknown', reason: 'No job was launched between 8 days and 1 day ago.' });
    expect(g['pool-claude']).toMatchObject({ current: null, currentText: 'unknown', status: 'unknown', reason: 'No usage reading.' });
  });
});

describe('trend direction', () => {
  const week = (perDay: number[]) => tally(perDay.flatMap((n, d) =>
    Array.from({ length: n }, (_, i) => merged(`D${d}-${i}`, d * DAY_MIN + 5 + i * Math.floor(DAY_MIN / n), d * 1000 + i + 1))));

  it('reads up, down and flat from the 7-day line, and the mark follows', () => {
    const up = goalsOf({ jobs: week([100, 100, 100, 50, 20, 20, 20]) })['merges-per-day']!;
    const down = goalsOf({ jobs: week([20, 20, 20, 50, 100, 100, 100]) })['merges-per-day']!;
    const flat = goalsOf({ jobs: week([50, 50, 50, 50, 50, 50, 50]) })['merges-per-day']!;
    expect([up.trend, down.trend, flat.trend]).toEqual(['up', 'down', 'flat']);
    expect([TREND_MARK[up.trend], TREND_MARK[down.trend], TREND_MARK[flat.trend]]).toEqual(['↑', '↓', '→']);
    expect(renderGoalScorecard(buildGoalScorecard({ ...NONE, jobs: week([100, 100, 100, 50, 20, 20, 20]) }))).toContain('Now 100 in the last 24 hours ↑');
  });

  it('reads the launch share trend by launch day, leaving out unsettled launches', () => {
    // Older days merged none, recent settled days merged all: rising.
    const lines = [2, 3, 4, 5, 6, 7].flatMap(d => [row({ event: 'launch', job: `L${d}`, ts: ago(d * DAY_MIN + 60) }),
      ...(d <= 4 ? [merged(`L${d}`, DAY_MIN, d)] : [])]);
    const g = goalsOf({ jobs: tally(lines) })['launches-merged']!;
    expect(g.trend7d.points).toHaveLength(7);
    expect(g.trend).toBe('up');
  });
});

describe('phm goals --json', () => {
  const dirs: string[] = [];
  afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it('prints the v3 model agents read: one object per goal with the documented fields', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-goals-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'metrics'), { recursive: true });
    writeFileSync(join(dir, 'metrics', 'jobs.jsonl'), [merged('J1', 30, 1), row({ event: 'launch', job: 'J1', ts: ago(2 * DAY_MIN) })].join('\n') + '\n');
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s: string) => { out.push(s); });
    expect(await cmdGoals(['--json'], { runsDir: dir, now: () => NOW })).toBe(0);
    const card = JSON.parse(out[0]!) as GoalScorecard;
    expect(Object.keys(card)).toEqual(['schema', 'version', 'generatedAt', 'malformedLines', 'targets', 'endState', 'goals', 'end_state_text', 'bets', 'bets_source', 'bets_reason', 'as_of']);
    expect(card).toMatchObject({ schema: 'fleet.goal-scorecard.v3', version: 3, generatedAt: new Date(NOW).toISOString() });
    for (const g of card.goals) {
      for (const key of ['id', 'title', 'why', 'metric', 'unit', 'target', 'current', 'trend', 'updated_at', 'source'] as const) expect(g).toHaveProperty(key);
      expect(['up', 'down', 'flat', 'unknown']).toContain(g.trend);
      expect(g.current === null || typeof g.current === 'number').toBe(true);
    }
    const byId = Object.fromEntries(card.goals.map(g => [g.id, g]));
    expect(byId['merges-per-day']).toMatchObject({ current: 1, status: 'behind' });
    expect(byId['launches-merged']).toMatchObject({ current: 100, status: 'on-track' });
    // No guardian table or status file in this runs dir: unknown, not 0.
    expect(byId['main-green']).toMatchObject({ current: null, status: 'unknown' });
  });
});
