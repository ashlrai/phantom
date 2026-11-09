import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { GoalsPane } from './GoalsPane.js';
vi.mock('../../../data/hooks.js', () => ({
  useQuery: () => ({ status: 'success', data: { available: true, observedAt: null, lanes: [{ lane: 'work', mergesPerHour: 0.5, medianOpenToMergeSeconds: 120, emptyRate: 0.25 }], pools: [{ pool: 'unknown-pool', usedPercent: null, resetAt: null }] } }),
  useRefetch: () => vi.fn(),
}));
it('shows lane measurements and unknown pool readings', () => {
  render(<GoalsPane {...({ visible: true } as Parameters<typeof GoalsPane>[0])} />);
  expect(screen.getByText('0.50')).toBeTruthy();
  expect(screen.getByText('25.0%')).toBeTruthy();
  expect(screen.getByText('unknown-pool')).toBeTruthy();
  expect(screen.getAllByText('unknown').length).toBeGreaterThanOrEqual(2);
});
