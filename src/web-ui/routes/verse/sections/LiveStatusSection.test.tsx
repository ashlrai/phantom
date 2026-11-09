import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { LiveStatusSection } from './LiveStatusSection.js';
vi.mock('../../../data/hooks.js', () => ({
  useQuery: () => ({ status: 'success', data: { state: 'idle', generatedAt: '2026-11-02T00:00:00Z', summary: { building: 1, queued: 2, parked: null }, lanes: [{ lane: 'local', busy: 1, slots: 2, capReason: null }], repos: [{ repo: 'ashlrai/phantom', openFleetPrs: 3, greenPct7d: null }], running: [], merged: null, blocked: [], spent: [{ pool: 'claude-max', pctUsed: null, resetAt: null }] } }),
  useRefetch: () => vi.fn(),
}));
it('shows the four lists without inventing usage or merge counts', () => {
  render(<LiveStatusSection />);
  for (const name of ['Running', 'Merged (24h)', 'Blocked', 'Spent']) expect(screen.getByRole('heading', { name })).toBeTruthy();
  expect(screen.getByText('Unknown')).toBeTruthy();
  expect(screen.getByText('claude-max: unknown · Reset unknown')).toBeTruthy();
  expect(screen.getByText('Running: 1 · Queued: 2 · Parked: unknown')).toBeTruthy();
  expect(screen.getByText('local: 1 busy / 2 slots')).toBeTruthy();
  expect(screen.getByText('ashlrai/phantom: 3 open fleet PRs · Post-merge green unknown')).toBeTruthy();
});
