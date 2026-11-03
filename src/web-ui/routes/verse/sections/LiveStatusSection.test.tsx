import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { LiveStatusSection } from './LiveStatusSection.js';
vi.mock('../../../data/hooks.js', () => ({
  useQuery: () => ({ status: 'success', data: { state: 'idle', generatedAt: '2026-11-02T00:00:00Z', running: [], merged: null, blocked: [], spent: [{ pool: 'claude-max', pctUsed: null, resetAt: null }] } }),
  useRefetch: () => vi.fn(),
}));
it('shows the four lists without inventing usage or merge counts', () => {
  render(<LiveStatusSection />);
  for (const name of ['Running', 'Merged (24h)', 'Blocked', 'Spent']) expect(screen.getByRole('heading', { name })).toBeTruthy();
  expect(screen.getByText('Unknown')).toBeTruthy();
  expect(screen.getByText('claude-max: unknown · Reset unknown')).toBeTruthy();
});
