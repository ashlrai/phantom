import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { NextIdeas } from './NextIdeas.js';

beforeEach(() => evictAll());
afterEach(() => vi.unstubAllGlobals());
it('shows three ranked ideas with their reasons and queue actions', async () => {
  stubSurfaceFetch({ routes: { '/api/verse/fleet/control/ideas': { schema: 'fleet.idea-list.v1', signals: [], ideas: [1, 2, 3].map(i => ({
    id: `vision:rq-${i}`, title: `Goal ${i}`, lane: 'claude', status: 'proposed', why: `Vision request ${i}`, evidence: {}, payoff: { score: 100 - i, text: `Payoff ${i}` },
  })) } } });
  render(<NextIdeas visible />);
  expect(await screen.findByText('Goal 1')).toBeInTheDocument();
  expect(screen.getAllByRole('listitem')).toHaveLength(3);
  expect(screen.getByText('Why: Vision request 2')).toBeInTheDocument();
  expect(screen.getAllByText('claude · proposed')).toHaveLength(3);
  expect(screen.getAllByRole('button', { name: /^Queue it:/ })).toHaveLength(3);
});
it('shows the empty state', async () => {
  stubSurfaceFetch({ routes: { '/api/verse/fleet/control/ideas': { schema: 'fleet.idea-list.v1', signals: [], ideas: [] } } });
  render(<NextIdeas visible />);
  expect(await screen.findByText('No ideas to queue right now.')).toBeInTheDocument();
});
