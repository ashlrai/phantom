import { expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RunningJobsList } from './RunningJobsList.js';
const state = vi.hoisted(() => ({ data: {} as Record<string, unknown>, status: 'success' }));
vi.mock('../../../data/hooks.js', () => ({ useQuery: () => state, useRefetch: () => () => {} }));
vi.mock('../shell/section-visibility.js', () => ({ usePollWhileVisible: () => {} }));
it('shows progress, marks stuck rows red and makes stale snapshots unknown', () => {
  const report = { known: true, generatedAt: new Date().toISOString(), jobs: ['moving', 'quiet', 'stuck'].map(status => ({ id: status, lane: 'local', repo: 'phantom', elapsed: 120, status, lastLine: 'working' })) };
  state.data = { value: { liveJobs: report } }; const view = render(<RunningJobsList />);
  expect(screen.getByText('stuck · local · phantom · 2m · stuck').closest('li')).toHaveAttribute('style', 'color: var(--status-danger-fg);');
  expect(screen.getAllByText('working')).toHaveLength(3);
  report.generatedAt = '2026-01-01T00:00:00Z'; view.rerender(<RunningJobsList />); expect(screen.getByText('Running jobs: unknown')).toBeVisible();
});
