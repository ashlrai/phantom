import { describe, expect, it, vi } from 'vitest';
import { cmdGoals } from '../src/cli/goals-view.js';
import {
  buildGoalScorecard, goalsEndState, jobsGoalTally, readGoalScorecard, renderGoalScorecard, type GoalScorecardInput,
} from '../src/core/fleet/goal-scorecard.js';
import type { FleetMainHealthV1 } from '../src/core/fleet/main-health.js';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const row = (v: Record<string, unknown>) => JSON.stringify(v);
const mains = (states: ('green' | 'red')[]): FleetMainHealthV1 => ({
  v: 1, generatedAt: ago(0), source: 'ok', statusAt: ago(5), stale: false, guardianOff: false, red: states.filter(s => s === 'red').length,
  repos: states.map((state, i) => ({ repo: `ashlrai/r${i}`, branch: 'main', sha: null, state, checkedAt: null, failingCheck: null, fixJobs: [], emptyAttempts: 0, retryHold: false, nightlyRed: null })),
});
/** `merged` PRs in the last 24 h, each opened `minutes` before it merged. */
function jobs(merged: number, minutes: number) {
  const t = jobsGoalTally(NOW);
  for (let i = 0; i < merged; i++) {
    t.add(row({ event: 'publish', job: `J${i}`, ts: ago(10 + i + minutes) }));
    t.add(row({ event: 'outcome', job: `J${i}`, state: 'MERGED', url: `https://github.com/ashlrai/phantom/pull/${i + 1}`, ts: ago(10 + i) }));
  }
  return t.report(true);
}
const card = (over: Partial<GoalScorecardInput> = {}) => buildGoalScorecard({
  now: NOW, jobs: jobs(120, 30), status: null, mains: mains(['green']), releaseLines: [], ...over,
});
const goal = (c: ReturnType<typeof card>, id: string) => c.goals.find(g => g.id === id)!;

describe('goal statuses and the end state', () => {
  it('on track: a goal at or above target says so, and the end state names no problem', () => {
    const c = card({ jobs: jobs(120, 30) });
    expect(goal(c, 'merges-per-day')).toMatchObject({ status: 'on-track', current: 120 });
    expect(goal(c, 'merges-per-day').statusText).toBe('on track');
  });

  it('behind: a goal under target is behind and the end state names it', () => {
    const c = card({ jobs: jobs(3, 30) });
    expect(goal(c, 'merges-per-day')).toMatchObject({ status: 'behind', current: 3 });
    expect(c.endState).toContain('Behind on');
    expect(c.endState).toContain('PRs merged per day');
  });

  it('a goal where lower is better: more minutes than the target is behind, fewer is on track', () => {
    expect(goal(card({ jobs: jobs(5, 200) }), 'publish-to-merge')).toMatchObject({ better: 'lower', status: 'behind' });
    expect(goal(card({ jobs: jobs(5, 20) }), 'publish-to-merge')).toMatchObject({ better: 'lower', status: 'on-track' });
  });

  it('no reading is unknown, never a guessed status, and never counted as on track', () => {
    const c = card({ jobs: null, mains: null });
    for (const g of c.goals) expect(g).toMatchObject({ status: 'unknown', current: null });
    expect(c.endState).toBe('No goal has a reading yet, so where the fleet is heading is unknown.');
  });

  it('a goal met through a green main still reads on track beside one with no reading', () => {
    const c = card({ jobs: null, mains: mains(['green', 'green']) });
    expect(goal(c, 'main-green').status).toBe('on-track');
    expect(c.endState).toMatch(/^On track on \d+ of \d+ goals\. \d+ have no reading yet\.$/);
  });

  it('an empty goal list has a plain end state and prints nothing invented', () => {
    expect(goalsEndState([])).toBe('No fleet goals yet.');
    expect(renderGoalScorecard({ ...card(), goals: [], endState: goalsEndState([]) })).toBe('No goals yet.');
  });
});

describe('the next planned step', () => {
  it('is carried only for the goal it is linked to; the others stay null', () => {
    const c = card({ nextSteps: { 'merges-per-day': 'Raise the claude lane to 8 workers.' } });
    expect(goal(c, 'merges-per-day').next).toBe('Raise the claude lane to 8 workers.');
    expect(goal(c, 'main-green').next).toBeNull();
    expect(renderGoalScorecard(c)).toContain('Next: Raise the claude lane to 8 workers.');
  });
});

describe('phm goals --json', () => {
  it('prints the end state first-class beside the goals', async () => {
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s: string) => { out.push(s); });
    const code = await cmdGoals(['--json'], { now: () => NOW, readLines: async () => false, readStatus: async () => null, readMains: async () => null, readReleaseLines: async () => null, nextSteps: { 'main-green': 'Fix the red repo.' } });
    vi.restoreAllMocks();
    expect(code).toBe(0);
    const parsed = JSON.parse(out[0]!) as ReturnType<typeof card>;
    expect(typeof parsed.endState).toBe('string');
    expect(parsed.goals.every(g => g.status === 'unknown' && 'next' in g)).toBe(true);
    expect(parsed.goals.find(g => g.id === 'main-green')?.next).toBe('Fix the red repo.');
    expect((await readGoalScorecard({ now: () => NOW, readLines: async () => false, readStatus: async () => null, readMains: async () => null, readReleaseLines: async () => null })).endState).toBe(parsed.endState);
  });
});
