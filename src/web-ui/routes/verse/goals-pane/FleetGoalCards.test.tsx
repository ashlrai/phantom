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
  id: 'merges-per-day', title: 'PRs merged per day', why: 'Merged PRs are the work that actually reaches the product.',
  metric: 'PRs merged in the last 24 hours', unit: 'PRs a day', target: 96, targetText: '96 or more a day', better: 'higher', current: 120,
  currentText: '120 in the last 24 hours', trend: 'flat', updated_at: '2026-11-17T11:55:00.000Z', source: 'metrics/jobs.jsonl',
  trend24h: trend([4, 5, 6], 'up', 4), trend7d: trend([96, 96, 96, 96, 96, 96, 96], 'flat', 96),
  status: 'on-track', statusText: 'on track', reason: 'Merging at or above target.', parts: [], evidencePane: 'fleet-metrics', next: null, ...over,
});
const unknown = (id: string, title: string, reason: string, evidencePane = 'fleet-metrics'): FleetGoal => goal({
  id, title, current: null, currentText: 'unknown', updated_at: null, trend: 'unknown', trend24h: NONE, trend7d: NONE, status: 'unknown',
  statusText: `unknown: ${reason[0]!.toLowerCase()}${reason.slice(1, -1)}`, reason, evidencePane,
});
const card = (goals: FleetGoal[]): GoalScorecard => ({
  schema: 'fleet.goal-scorecard.v3', version: 3, generatedAt: '2026-11-17T12:00:00.000Z', malformedLines: 0, endState: 'Behind on 1 of 3 goals: Releases.',
  targets: { mergesPerDay: 96, publishToMergeMinutes: 60, launchesMergedPercent: 50, releasesPerRepoPer7d: 1, poolUsedByResetPercent: 90, wastedLaunchRate: 0.2 },
  goals,
});
/** Deliberately on-track first: the view must still lead with the behind goal. */
const MIXED = card([
  goal({}),
  { ...unknown('main-green', 'Default branches green', 'The main guardian table could not be read.', 'fleet-mission'),
    target: null, targetText: 'Every repo green', unit: 'repos', why: 'A red default branch blocks every merge into that repo.' },
  goal({
    id: 'releases-7d', title: 'Releases in the last 7 days, per repo', why: 'Merged work only helps people once it ships in a release.',
    targetText: '1 release or more per repo', target: 1, current: 0, trend: 'up',
    currentText: '3 releases across 2 repos; fewest in one repo: 0', trend24h: trend([0, 1, 0, 2], 'up', null), trend7d: trend([0, 0, 1, 0, 0, 0, 2], 'up', null),
    status: 'behind', statusText: 'behind', reason: 'Too few releases: ashlrai/locus (0).', evidencePane: 'fleet-releases',
    parts: [{ name: 'ashlrai/locus', value: 0 }, { name: 'ashlrai/phantom', value: 3 }],
  }),
]);
const ALL_UNKNOWN = card([
  unknown('merges-per-day', 'PRs merged per day', 'The jobs ledger could not be read.'),
  unknown('publish-to-merge', 'Time from PR opened to merged', 'The jobs ledger could not be read.', 'fleet-merges'),
  unknown('releases-7d', 'Releases in the last 7 days, per repo', 'The release log could not be read.', 'fleet-releases'),
]);

let viewport: ViewportMock | null = null;
beforeEach(() => { evictAll(); });
afterEach(() => { cleanup(); viewport?.restore(); viewport = null; vi.unstubAllGlobals(); });
const titles = () => screen.getAllByRole('button', { name: 'See evidence' }).map(b => b.closest('section, article, div[class]')?.textContent ?? '');

describe.each([['desktop width', 1440], ['390 px', 390]])('FleetGoalCards at %s', (_name, width) => {
  it('shows the vision line and the current bets, or why there are none', async () => {
    viewport = mockViewport(width);
    stubSurfaceFetch({ routes: { [ROUTE]: { ...MIXED, end_state_text: 'Ship fewer, better PRs', bets_source: 'leader/VISION.md', as_of: '2026-11-17T11:00:00.000Z',
      bets: [{ id: 'RQ-ONE', pool: 'claude', repo: 'phantom', goal: 'Fix the thing.' }] } } });
    render(<FleetGoalCards />);
    expect(await screen.findByText('Ship fewer, better PRs')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Current bets' })).toHaveTextContent('RQ-ONE (claude, phantom): Fix the thing.');
  });
  it('says plainly when the vision file is missing', async () => {
    viewport = mockViewport(width);
    stubSurfaceFetch({ routes: { [ROUTE]: { ...MIXED, end_state_text: null, bets: [], bets_source: null, bets_reason: 'The leader vision file is missing or could not be read.', as_of: null } } });
    render(<FleetGoalCards />);
    expect(await screen.findByText(/Current bets: none\. The leader vision file is missing/)).toBeInTheDocument();
  });
  it('leads with the behind goal and draws each trend against its target', async () => {
    viewport = mockViewport(width);
    stubSurfaceFetch({ routes: { [ROUTE]: MIXED } });
    const openPane = vi.fn();
    render(<FleetGoalCards host={{ openPane } as never} />);
    expect(await screen.findByText('1 behind · 1 on track · 1 unknown')).toBeInTheDocument();
    const order = titles();
    expect(order[0]).toContain('Releases in the last 7 days, per repo');
    expect(order[1]).toContain('Default branches green');
    expect(order[2]).toContain('PRs merged per day');
    // The number, an up/down/flat mark, the target and why it matters.
    expect(screen.getByText('120 in the last 24 hours')).toBeInTheDocument();
    expect(screen.getByText('Target: 96 or more a day')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Trend: steady' })).toHaveTextContent('→');
    expect(screen.getByRole('img', { name: 'Trend: rising' })).toHaveTextContent('↑');
    expect(screen.getByText('Merged work only helps people once it ships in a release.')).toBeInTheDocument();
    expect(screen.getByText('Behind')).toBeInTheDocument();
    expect(screen.getByText('ashlrai/locus 0 · ashlrai/phantom 3')).toBeInTheDocument();
    const merges7d = screen.getByRole('img', { name: /PRs merged per day, last 7 days/ });
    expect(merges7d.querySelector('line[data-target]')?.getAttribute('data-target')).toBe('96');
    expect(screen.getByRole('img', { name: /PRs merged per day, last 24 hours/ })).toBeInTheDocument();
    // Release counts are not in the target's unit, so no target line is drawn.
    expect(screen.getByRole('img', { name: /Releases in the last 7 days, per repo, last 7 days/ }).querySelector('line[data-target]')).toBeNull();
    expect(screen.getAllByText('24 h: rising', { selector: 'figcaption' })).toHaveLength(2);
    expect(screen.getAllByText('7 d: steady')).toHaveLength(1);
    expect(screen.getByText('Unknown: The main guardian table could not be read.')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Trend: no trend yet' })).toHaveTextContent('?');
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
    // No invented line or direction: every mark says there is no trend yet.
    expect(screen.queryAllByRole('img', { name: /last (24 hours|7 days)/ })).toHaveLength(0);
    expect(screen.getAllByRole('img', { name: 'Trend: no trend yet' })).toHaveLength(3);
    expect(screen.queryByText(/[↑↓→]/)).toBeNull();
    expect(screen.queryByText(/^0$/)).toBeNull();
    // Why it matters is fixed per goal, so it shows even with no reading.
    expect(screen.getAllByText('Merged PRs are the work that actually reaches the product.')).toHaveLength(3);
    // No host to open a pane in (the phone): no dead "See evidence" button.
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getAllByText('No 24 h trend yet.')).toHaveLength(3);
    expect(screen.getAllByText('No 7 d trend yet.')).toHaveLength(3);
  });
});

describe('FleetGoalCards', () => {
  it('orders behind, unknown, on track and keeps ties stable', () => {
    const goals = goalsInOrder(MIXED.goals);
    expect(goals.map(g => g.id)).toEqual(['releases-7d', 'main-green', 'merges-per-day']);
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

describe('end state and next step', () => {
  it('shows the one-sentence end state on top and a next step only where one is linked', async () => {
    viewport = mockViewport(390);
    const withNext = card([goal({ next: 'Raise the claude lane to 8 workers.' }), goal({ id: 'b', title: 'Second goal' }), goal({ id: 'c', title: 'Third goal' })]);
    stubSurfaceFetch({ routes: { [ROUTE]: { ...withNext, endState: 'On track on every goal.' } } });
    render(<FleetGoalCards />);
    expect(await screen.findByText('On track on every goal.')).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 3 }).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Target: 96 or more a day')).toHaveLength(3);
    expect(screen.getAllByText(/^Next: /)).toHaveLength(1);
    expect(screen.getByText('Next: Raise the claude lane to 8 workers.')).toBeInTheDocument();
  });
});
