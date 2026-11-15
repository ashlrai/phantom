import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { GoalsPane } from './GoalsPane.js';

const mission = { schemaVersion: 1, state: 'steady', authority: 'read-only', briefing: null, sources: { briefing: null, goals: null, enrollment: null, proposals: null } };
const goal = (id: string, objective: string) => ({ id, objective, status: 'active', progress: { fractionDone: 0.2, counts: {}, nextActionableId: null }, milestones: [] });
const runs = (generatedAt: string) => ({ generatedAt, mergesLastHour: { count: 5, perHour: 5, items: [] } });

beforeEach(() => { evictAll(); localStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('GoalsPane metrics', () => {
  it('shows unknown, not 0, when there is no reading or no mapping', async () => {
    stubSurfaceFetch({ routes: { '/api/goals': [goal('g1', 'Raise merge throughput'), goal('g2', 'Write the vision doc')], '/api/vision/mission': mission } });
    const { container } = render(<GoalsPane />);
    await screen.findByText('Raise merge throughput');
    expect((await screen.findAllByText('unknown')).length).toBeGreaterThanOrEqual(2);
    expect(container.textContent).not.toMatch(/(^|\s)0\/h/);
    expect(await screen.findByText('no metric is bound to this goal')).toBeInTheDocument();
  });

  it('renders the stale badge for an old reading and live for a fresh one', async () => {
    const old = new Date(Date.now() - 31 * 60_000).toISOString();
    stubSurfaceFetch({ routes: { '/api/goals': [goal('g1', 'Raise merge throughput')], '/api/vision/mission': mission, '/api/verse/fleet/runs': runs(old) } });
    render(<GoalsPane />);
    expect(await screen.findByText('5/h')).toBeInTheDocument();
    expect(screen.getByText('stale')).toBeInTheDocument();
    expect(screen.getByText('Δ24h unknown')).toBeInTheDocument();
  });

  it('renders live for a fresh reading', async () => {
    stubSurfaceFetch({ routes: { '/api/goals': [goal('g1', 'Raise merge throughput')], '/api/vision/mission': mission, '/api/verse/fleet/runs': runs(new Date().toISOString()) } });
    render(<GoalsPane />);
    expect(await screen.findByText('live')).toBeInTheDocument();
  });
});
