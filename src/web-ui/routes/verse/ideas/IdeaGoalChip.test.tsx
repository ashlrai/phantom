import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { IdeasPane } from './IdeasPane.js';
import { openDockPane } from '../dock/dock-store.js';

vi.mock('../dock/dock-store.js', async importOriginal => ({ ...(await importOriginal<typeof import('../dock/dock-store.js')>()), openDockPane: vi.fn() }));
beforeEach(() => { evictAll(); localStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

it('shows goal chips, navigates, and persists the filter', async () => {
  stubSurfaceFetch({ routes: {
    '/api/goals': [{ id: 'g1', objective: 'Ship releases', status: 'active', milestones: [], progress: { fractionDone: 0, counts: {}, nextActionableId: null } }],
    '/api/backlog': [{ id: 'a', title: 'Unlinked', repo: 'a' }, { id: 'b', title: 'Use g1', repo: 'b' }],
  } });
  const view = render(<IdeasPane />);
  fireEvent.click(await screen.findByRole('button', { name: /Ship releases/ }));
  expect(openDockPane).toHaveBeenCalledWith('goals');
  expect(screen.getByText('no goal')).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('Only ideas that serve a goal'));
  expect(screen.queryByText('Unlinked')).toBeNull();
  view.unmount();
  render(<IdeasPane />);
  await waitFor(() => expect(screen.getByLabelText('Only ideas that serve a goal')).toBeChecked());
  expect(screen.queryByText('Unlinked')).toBeNull();
});
