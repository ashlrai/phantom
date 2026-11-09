import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { MetricsPane } from './MetricsPane.js';
vi.mock('../../../data/hooks.js', () => ({
  useQuery: () => ({ status: 'success', data: { observedAt: null, lanes: [{ lane: 'work', mergesPerHour: 0.5, medianOpenToMergeSeconds: 120, emptyRate: 0.25, running: 2, target: 4 }] } }),
  useRefetch: () => vi.fn(),
}));
it('shows the rollup and unknown hourly history', () => {
  render(<MetricsPane {...({ visible: true } as Parameters<typeof MetricsPane>[0])} />);
  expect(screen.getByText('0.50')).toBeTruthy();
  expect(screen.getByText('25.0%')).toBeTruthy();
  expect(screen.getByText('2 / 4')).toBeTruthy();
  expect(screen.getByText('Hourly merges over 24 hours: unknown')).toBeTruthy();
});
