import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { MetricsPane } from './MetricsPane.js';
vi.mock('../../../data/hooks.js', () => ({
  useQuery: () => ({ status: 'success', data: { observedAt: null, generatorYield: { known: true, malformedLines: 1, generators: [{ generator: 'filler', jobs: 2, prs: 1, merged: 1, emptyRate: null, medianDiffLines: 12, tokensPerMergedPr: null }] }, lanes: [{ lane: 'work', mergesPerHour: 0.5, medianOpenToMergeSeconds: 120, emptyRate: 0.25, running: 2, target: 4 }] } }),
  useRefetch: () => vi.fn(),
}));
it('shows the rollup and unknown hourly history', () => {
  render(<MetricsPane {...({ visible: true } as Parameters<typeof MetricsPane>[0])} />);
  expect(screen.getByText('0.50')).toBeTruthy();
  expect(screen.getByText('25.0%')).toBeTruthy();
  expect(screen.getByText('2 / 4')).toBeTruthy();
  expect(screen.getByText('Hourly merges over 24 hours: unknown')).toBeTruthy();
});

it('shows generator yield and missing measurements', () => {
  render(<MetricsPane {...({ visible: true } as Parameters<typeof MetricsPane>[0])} />);
  expect(screen.getByText('filler')).toBeTruthy();
  expect(screen.getByText('Malformed lines skipped: 1')).toBeTruthy();
  expect(screen.getAllByText('unknown').length).toBeGreaterThan(0);
});
