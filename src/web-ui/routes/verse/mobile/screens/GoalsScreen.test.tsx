/**
 * The Goals screen on the phone: open goals through the desktop pane's own
 * model (openGoals/goalLine/goalsHeadline) and metric binding
 * (useGoalMetrics), the mission line, the unavailable state on a failed
 * read, and Back to More.
 */
import { fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../../data/cache.js';
import { json, renderMobile, stubFetch } from '../mobile.test-support.js';
import { GoalsScreen } from './GoalsScreen.js';

const goals = [
  {
    id: 'g1',
    objective: 'Merge ten PRs an hour',
    status: 'active',
    milestones: [
      { title: 'Wire the metric', status: 'done', order: 1 },
      { title: 'Ship it', status: 'open', order: 2 },
    ],
    progress: { fractionDone: 0.5, counts: {}, nextActionableId: 'm2' },
  },
  {
    id: 'g2',
    objective: 'Tidy the workbench',
    status: 'paused',
    milestones: [],
    progress: { fractionDone: 0, counts: {}, nextActionableId: null },
  },
  {
    id: 'g3',
    objective: 'An already finished goal',
    status: 'done',
    milestones: [],
    progress: { fractionDone: 1, counts: {}, nextActionableId: null },
  },
];

const mission = { schemaVersion: 1, state: 'healthy', authority: 'goals', briefing: null, preview: null, shadow: null, sources: { briefing: null, goals: null, enrollment: null, proposals: null } };
const runs = { generatedAt: new Date().toISOString(), mergesLastHour: { perHour: 4 }, merges: [] };
const backlogRead = { v: 1, repo: 'ashlrai/phantom', generatedAt: new Date().toISOString(), source: 'ok', items: [], counts: { mergeState: { DIRTY: 2 }, actions: { merge: 0, recut: 0, refresh: 0, wait: 0, none: 0 } } };

function stubAll() {
  return stubFetch({
    'GET /api/goals': goals,
    'GET /api/vision/mission': mission,
    'GET /api/verse/fleet/runs': runs,
    'GET /api/verse/github/fleet-backlog': backlogRead,
  });
}

afterEach(() => {
  evictAll();
  vi.unstubAllGlobals();
});

describe('GoalsScreen', () => {
  it('renders open goals through the desktop model with the live metric', async () => {
    stubAll();
    renderMobile(<GoalsScreen />);
    expect(await screen.findByText('Merge ten PRs an hour')).toBeInTheDocument();
    expect(screen.getByText('1 active · 1 paused · 0 planning')).toBeInTheDocument();
    expect(screen.getByText('Mission state: healthy')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByText('Next: Ship it')).toBeInTheDocument();
    expect(screen.getByText('1 of 2 done')).toBeInTheDocument();
    // merges-per-hour binding: a live value with the pane's own wording.
    expect(screen.getByText('4/h')).toBeInTheDocument();
    expect(screen.getByText('live')).toBeInTheDocument();
    // The unbound goal stays honestly unknown, never zero.
    expect(screen.getByText('no metric is bound to this goal')).toBeInTheDocument();
    // Done goals are history and do not list.
    expect(screen.queryByText('An already finished goal')).not.toBeInTheDocument();
  });

  it('leads with the fleet goal cards from the same scorecard as `phm goals`', async () => {
    const fleetGoal = (id: string, current: number | null, trend: 'up' | 'unknown') => ({
      id, title: id === 'merges-per-day' ? 'PRs merged per day' : 'Default branches green', why: `Why ${id} matters.`, metric: 'm', unit: 'u',
      target: 1, targetText: `target for ${id}`, better: 'higher', current, currentText: current === null ? 'unknown' : `${current} now`,
      trend, trend24h: { points: [], direction: 'unknown', target: null }, trend7d: { points: [], direction: trend, target: null },
      updated_at: null, source: 'metrics/jobs.jsonl', status: current === null ? 'unknown' : 'on-track',
      statusText: current === null ? 'unknown: no reading yet' : 'on track', reason: current === null ? 'No reading yet.' : 'Fine.', parts: [], evidencePane: 'fleet-metrics',
    });
    stubFetch({
      'GET /api/goals': goals, 'GET /api/vision/mission': mission, 'GET /api/verse/fleet/runs': runs, 'GET /api/verse/github/fleet-backlog': backlogRead,
      'GET /api/verse/fleet/runs/goal-scorecard': { schema: 'fleet.goal-scorecard.v3', version: 3, generatedAt: new Date().toISOString(), malformedLines: 0, targets: {},
        goals: [fleetGoal('merges-per-day', 120, 'up'), fleetGoal('main-green', null, 'unknown')] },
    });
    renderMobile(<GoalsScreen />);
    expect(await screen.findByText('120 now')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Trend: rising' })).toHaveTextContent('↑');
    expect(screen.getByText('Target: target for merges-per-day')).toBeInTheDocument();
    expect(screen.getByText('Why merges-per-day matters.')).toBeInTheDocument();
    // Missing data reads unknown, never 0.
    expect(screen.getByText('Unknown: No reading yet.')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Trend: no trend yet' })).toHaveTextContent('?');
    // The phone has no pane to open, so no dead evidence button.
    expect(screen.queryByRole('button', { name: 'See evidence' })).toBeNull();
    // The personal goals still follow.
    expect(await screen.findByText('Merge ten PRs an hour')).toBeInTheDocument();
  });

  it('shows the unavailable state when the goals read fails', async () => {
    stubFetch({ 'GET /api/goals': () => json({ error: 'boom' }, 500) });
    renderMobile(<GoalsScreen />);
    expect(await screen.findByText('Couldn’t load goals')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('Back goes to More', async () => {
    stubAll();
    const { context } = renderMobile(<GoalsScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(context.navigate).toHaveBeenCalledWith({ screen: 'more' });
  });
});
