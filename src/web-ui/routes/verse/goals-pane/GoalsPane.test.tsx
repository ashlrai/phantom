import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { GoalsPane } from './GoalsPane.js';

const mission = { schemaVersion: 1, state: 'steady', authority: 'read-only', briefing: null, sources: { briefing: null, goals: null, enrollment: null, proposals: null } };
const goal = (id: string, objective: string, status = 'active', fractionDone = 0.5) => ({
  id, objective, status, progress: { fractionDone, counts: {}, nextActionableId: null },
  milestones: [{ title: 'Ship the draft', status: 'pending', order: 1 }, { title: 'Review', status: 'done', order: 0 }],
});
const fail = () => new Response(JSON.stringify({ error: 'goals store unreadable' }), { status: 500, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('GoalsPane', () => {
  it('shows the headline, mission state and a card per open goal', async () => {
    stubSurfaceFetch({ routes: { '/api/goals': [goal('g1', 'Grow the fleet'), goal('g2', 'Old work', 'done', 1)], '/api/vision/mission': mission } });
    render(<GoalsPane />);
    expect(await screen.findByText('Grow the fleet')).toBeInTheDocument();
    expect(screen.queryByText('Old work')).toBeNull();
    expect(screen.getByText('1 active · 0 paused · 0 planning')).toBeInTheDocument();
    expect(screen.getByText('Mission state: steady')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByText('Next: Ship the draft')).toBeInTheDocument();
    expect(screen.getByText('1 of 2 done')).toBeInTheDocument();
    expect(screen.getAllByRole('button').map(b => b.textContent)).toEqual(['Add', 'Steer']);
  });

  it('keeps the mission line when goals fail', async () => {
    stubSurfaceFetch({ routes: { '/api/goals': fail, '/api/vision/mission': mission } });
    render(<GoalsPane />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(await screen.findByText('Mission state: steady')).toBeInTheDocument();
  });

  it('keeps the goals when the mission fails', async () => {
    stubSurfaceFetch({ routes: { '/api/goals': [goal('g1', 'Grow the fleet')], '/api/vision/mission': fail } });
    render(<GoalsPane />);
    expect(await screen.findByText('Grow the fleet')).toBeInTheDocument();
    expect(await screen.findByText('Mission state unavailable')).toBeInTheDocument();
  });

  it('shows the empty state', async () => {
    stubSurfaceFetch({ routes: { '/api/goals': [], '/api/vision/mission': mission } });
    render(<GoalsPane />);
    expect(await screen.findByText('No open goals. Add one above, or with `ashlr goals add "<objective>"`.')).toBeInTheDocument();
  });

  it('renders an objective containing markup as text', async () => {
    stubSurfaceFetch({ routes: { '/api/goals': [goal('g1', 'Fix <img src=x> now')], '/api/vision/mission': mission } });
    const { container } = render(<GoalsPane />);
    expect(await screen.findByText('Fix <img src=x> now')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });
});
