import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FleetGoal, GoalScorecard, GoalTrend } from '../../../../core/fleet/goal-scorecard.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { mockViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { FleetGoalCards, goalsInOrder, goalsSummary } from './FleetGoalCards.js';

const ROUTE = '/api/verse/fleet/runs/goal-scorecard';
const trend = (points: (number | null)[], direction: GoalTrend['direction'], target: number | null): GoalTrend => ({ points, direction, target });
const NONE = trend([], 'unknown', null);
const goal = (over: Partial<FleetGoal>): FleetGoal => ({
  id: 'merges-per-hour', title: 'PRs merged per hour', target: '4 or more an hour', targetValue: 4, better: 'higher', value: 5,
  valueText: '5 an hour (120 in 24 h)', asOf: '2026-11-17T11:55:00.000Z', source: 'metrics/jobs.jsonl',
  trend24h: trend([4, 5, 6], 'up', 4), trend7d: trend([4, 4, 4, 4, 4, 4, 4], 'flat', 4),
  status: 'on-track', statusText: 'on track', why: 'Merging at or above target.', parts: [], evidencePane: 'fleet-metrics', ...over,
});
const unknown = (id: string, title: string, why: string, evidencePane = 'fleet-metrics'): FleetGoal => goal({
  id, title, value: null, valueText: 'unknown', asOf: null, trend24h: NONE, trend7d: NONE, status: 'unknown',
  statusText: `unknown: ${why[0]!.toLowerCase()}${why.slice(1, -1)}`, why, evidencePane,
});
const card = (goals: FleetGoal[]): GoalScorecard => ({
  schema: 'fleet.goal-scorecard.v2', version: 2, generatedAt: '2026-11-17T12:00:00.000Z', malformedLines: 0,
  targets: { mergesPerHour: 4, publishToMergeMinutes: 60, emptyFinishRate: 0.2, mainGreenPercent: 100, releasesPerRepoPer7d: 1, poolUsedByResetPercent: 90 },
  goals,
});
/** Deliberately on-track first: the view must still lead with the behind goal. */
const MIXED = card([
  goal({}),
  unknown('main-green', 'Main branch green in every repo', 'The main guardian table could not be read.', 'fleet-mission'),
  goal({
    id: 'releases-7d', title: 'Releases in the last 7 days, per repo', target: '1 release or more per repo', targetValue: 1, value: 0,
    valueText: '3 releases across 2 repos; fewest in one repo: 0', trend24h: trend([0, 1, 0, 2], 'up', null), trend7d: trend([0, 0, 1, 0, 0, 0, 2], 'up', null),
    status: 'behind', statusText: 'behind', why: 'Too few releases: ashlrai/locus (0).', evidencePane: 'fleet-releases',
    parts: [{ name: 'ashlrai/locus', value: 0 }, { name: 'ashlrai/phantom', value: 3 }],
  }),
]);
const ALL_UNKNOWN = card([
  unknown('merges-per-hour', 'PRs merged per hour', 'The jobs ledger could not be read.'),
  unknown('publish-to-merge', 'Median time from publish to merge', 'The jobs ledger could not be read.', 'fleet-merges'),
  unknown('releases-7d', 'Releases in the last 7 days, per repo', 'The release log could not be read.', 'fleet-releases'),
]);

let viewport: ViewportMock | null = null;
beforeEach(() => { evictAll(); });
afterEach(() => { cleanup(); viewport?.restore(); viewport = null; vi.unstubAllGlobals(); });
const titles = () => screen.getAllByRole('button', { name: 'See evidence' }).map(b => b.closest('section, article, div[class]')?.textContent ?? '');

describe.each([['desktop width', 1440], ['390 px', 390]])('FleetGoalCards at %s', (_name, width) => {
  it('leads with the behind goal and draws each trend against its target', async () => {
    viewport = mockViewport(width);
    stubSurfaceFetch({ routes: { [ROUTE]: MIXED } });
    const openPane = vi.fn();
    render(<FleetGoalCards host={{ openPane } as never} />);
    expect(await screen.findByText('1 behind · 1 on track · 1 unknown')).toBeInTheDocument();
    const order = titles();
    expect(order[0]).toContain('Releases in the last 7 days, per repo');
    expect(order[1]).toContain('Main branch green in every repo');
    expect(order[2]).toContain('PRs merged per hour');
    expect(screen.getByText('Behind')).toBeInTheDocument();
    expect(screen.getByText('ashlrai/locus 0 · ashlrai/phantom 3')).toBeInTheDocument();
    const merges7d = screen.getByRole('img', { name: /PRs merged per hour, last 7 days/ });
    expect(merges7d.querySelector('line[data-target]')?.getAttribute('data-target')).toBe('4');
    expect(screen.getByRole('img', { name: /PRs merged per hour, last 24 hours/ })).toBeInTheDocument();
    // Release counts are not in the target's unit, so no target line is drawn.
    expect(screen.getByRole('img', { name: /Releases in the last 7 days, per repo, last 7 days/ }).querySelector('line[data-target]')).toBeNull();
    expect(screen.getAllByText('24 h: rising', { selector: 'figcaption' })).toHaveLength(2);
    expect(screen.getAllByText('7 d: steady')).toHaveLength(1);
    expect(screen.getByText('Unknown: The main guardian table could not be read.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
    const actions = screen.getAllByRole('button', { name: 'See evidence' });
    fireEvent.click(actions[0]!);
    expect(openPane).toHaveBeenCalledWith('fleet-releases');
  });

  it('shows the all-unknown state with every reason and no invented line', async () => {
    viewport = mockViewport(width);
    stubSurfaceFetch({ routes: { [ROUTE]: ALL_UNKNOWN } });
    render(<FleetGoalCards />);
    expect(await screen.findByText('No goal has a reading yet.')).toBeInTheDocument();
    expect(screen.getAllByText('Unknown')).toHaveLength(3);
    expect(screen.getAllByText('unknown')).toHaveLength(3);
    expect(screen.getAllByText('Unknown: The jobs ledger could not be read.')).toHaveLength(2);
    expect(screen.getByText('Unknown: The release log could not be read.')).toBeInTheDocument();
    expect(screen.queryAllByRole('img')).toHaveLength(0);
    expect(screen.getAllByText('No 24 h trend yet.')).toHaveLength(3);
    expect(screen.getAllByText('No 7 d trend yet.')).toHaveLength(3);
  });
});

describe('FleetGoalCards', () => {
  it('orders behind, unknown, on track and keeps ties stable', () => {
    const goals = goalsInOrder(MIXED.goals);
    expect(goals.map(g => g.id)).toEqual(['releases-7d', 'main-green', 'merges-per-hour']);
    expect(goalsSummary([])).toBe('');
    expect(goalsSummary(ALL_UNKNOWN.goals)).toBe('No goal has a reading yet.');
  });

  it('shows an empty state when there are no goals', async () => {
    stubSurfaceFetch({ routes: { [ROUTE]: card([]) } });
    render(<FleetGoalCards />);
    expect(await screen.findByText(/No fleet goals yet/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('says unavailable when the scorecard cannot be read', async () => {
    stubSurfaceFetch({ routes: { [ROUTE]: null } });
    render(<FleetGoalCards />);
    expect(await screen.findByText('Fleet goals are unavailable right now.')).toBeInTheDocument();
  });

  it('lists the Goals view in the Cmd+K pane catalog', async () => {
    await import('./goals.pane.js');
    const { listPanes } = await import('../panes/pane-registry.js');
    expect(listPanes().find(p => p.id === 'goals')).toMatchObject({ title: 'Goals', needsSession: false });
  });
});
