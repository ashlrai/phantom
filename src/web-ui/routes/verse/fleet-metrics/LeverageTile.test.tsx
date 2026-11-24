import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { buildLeverageReport } from '../../../../core/metrics/leverage-class.js';
import { LeverageTile } from './LeverageTile.js';

const now = Date.parse('2026-11-18T12:00:00Z');
const merged = (job: string, minutesAgo: number) => JSON.stringify({ event: 'outcome', state: 'MERGED', job, ts: new Date(now - minutesAgo * 60_000).toISOString() });

it('shows the share, the trend and the counts per class in words', () => {
  const jobs = [merged('RQ-DVL-FLEET-1', 10), merged('RQ-DESKTOP-TILE', 20), merged('RQ-CL-DOCS-1', 90), merged('RQ-ODD', 100)].join('\n');
  render(<LeverageTile report={buildLeverageReport(jobs, null, now, 24)} />);
  expect(screen.getByRole('heading', { name: 'Merge leverage' })).toBeTruthy();
  expect(screen.getByText('50% of 4 merges in the last 24 hours moved the fleet or the product.')).toBeTruthy();
  expect(screen.getByText('fleet 1 · product 1 · docs 1 · filler 0 · unknown 1')).toBeTruthy();
  expect(screen.getByRole('img', { name: /Fleet and product share of merges per hour/ })).toBeTruthy();
});

it('says so in words for no merges, an unreadable ledger and a missing report', () => {
  const { rerender } = render(<LeverageTile report={buildLeverageReport('', null, now, 6)} />);
  expect(screen.getByText('No merges in the last 6 hours')).toBeTruthy();
  rerender(<LeverageTile report={buildLeverageReport(null, null, now)} />);
  expect(screen.getByText('Merge leverage: unknown')).toBeTruthy();
  rerender(<LeverageTile report={undefined} />);
  expect(screen.getByText('Merge leverage: unknown')).toBeTruthy();
});
