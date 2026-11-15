import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { IdeasPane } from './IdeasPane.js';

beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); });

it('shows the goal and filters ideas by it', async () => {
  stubSurfaceFetch({ routes: {
    '/api/goals': [{ id: 'g1', objective: 'Improve delivery', status: 'active', milestones: [], progress: { fractionDone: 0, counts: {}, nextActionableId: null } }],
    '/api/backlog': [
      { id: 'one', title: 'Drift idea', source: 'goal-drift', goalId: 'g1', repo: 'org/a' },
      { id: 'two', title: 'Other idea', source: 'issue', repo: 'org/a' },
    ],
  } });
  render(<IdeasPane />);
  expect(await screen.findByRole('button', { name: 'for: Improve delivery' })).toBeInTheDocument();
  expect(screen.getByText('Other idea')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Goal:'), { target: { value: 'g1' } });
  expect(screen.getByText('Drift idea')).toBeInTheDocument();
  expect(screen.queryByText('Other idea')).toBeNull();
});
