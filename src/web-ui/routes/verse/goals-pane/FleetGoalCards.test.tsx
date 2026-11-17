import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FleetGoal } from '../../../../core/fleet/goal-scorecard.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { FleetGoalCards } from './FleetGoalCards.js';

const ROUTE = '/api/verse/fleet/runs/goal-scorecard';
const goal = (over: Partial<FleetGoal>): FleetGoal => ({
  id: 'merges-per-hour', title: 'PRs merged per hour', target: '4 or more an hour', value: 5, valueText: '5 an hour (120 in 24 h)',
  asOf: '2026-11-17T11:55:00.000Z', source: 'metrics/jobs.jsonl', trend: { points: [4, 5, 6], direction: 'up' },
  status: 'on-track', why: 'Merging at or above target.', evidencePane: 'fleet-metrics', ...over,
});
const card = (goals: FleetGoal[]) => ({ schema: 'fleet.goal-scorecard.v1', generatedAt: '2026-11-17T12:00:00.000Z', malformedLines: 0, goals });

beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('FleetGoalCards', () => {
  it('renders one card per goal with status, trend line and one evidence action', async () => {
    stubSurfaceFetch({ routes: { [ROUTE]: card([
      goal({}),
      goal({ id: 'main-green', title: 'Main branch green in every repo', value: null, valueText: 'unknown', status: 'unknown', trend: { points: [], direction: 'unknown' }, why: 'The main guardian table could not be read.', evidencePane: 'fleet-mission', asOf: null }),
    ]) } });
    const openPane = vi.fn();
    render(<FleetGoalCards host={{ openPane } as never} />);
    expect(await screen.findByText('PRs merged per hour')).toBeInTheDocument();
    expect(screen.getByText('On track')).toBeInTheDocument();
    expect(screen.getByText('5 an hour (120 in 24 h)')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /PRs merged per hour, last 24 hours/ })).toBeInTheDocument();
    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(screen.getByText('unknown')).toBeInTheDocument();
    expect(screen.getByText('No 24 h trend yet.')).toBeInTheDocument();
    const actions = screen.getAllByRole('button', { name: 'See evidence' });
    expect(actions).toHaveLength(2);
    fireEvent.click(actions[1]!);
    expect(openPane).toHaveBeenCalledWith('fleet-mission');
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
});
