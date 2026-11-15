import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { NextIdeas } from './NextIdeas.js';

beforeEach(() => evictAll());
afterEach(() => vi.unstubAllGlobals());
it('shows three ranked ideas with their job details', async () => {
  stubSurfaceFetch({ routes: { '/api/ideas': { schema: 'fleet.ideas.v1', missing: [], ideas: [1, 2, 3].map(i => ({ id: `RQ-${i}`, repo: `repo${i}`, lane: 'work', goal: `Goal ${i}` })) } } });
  render(<NextIdeas visible />);
  expect(await screen.findByText('Goal 1')).toBeInTheDocument();
  expect(screen.getAllByRole('listitem')).toHaveLength(3);
  expect(screen.getByText('RQ-2 · repo2 · work')).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: 'Open job' })).toHaveLength(3);
});
it('shows the empty state', async () => {
  stubSurfaceFetch({ routes: { '/api/ideas': { schema: 'fleet.ideas.v1', missing: [], ideas: [] } } });
  render(<NextIdeas visible />);
  expect(await screen.findByText('No ideas yet.')).toBeInTheDocument();
});
