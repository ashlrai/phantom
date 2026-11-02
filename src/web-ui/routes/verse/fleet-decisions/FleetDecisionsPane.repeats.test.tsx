import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { resetWorkerLogSelection, takeRequestedWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetDecisionsPane } from './FleetDecisionsPane.js';
import { fixture } from './fixtures.js';

beforeEach(() => evictAll());
afterEach(() => { cleanup(); resetWorkerLogSelection(); vi.unstubAllGlobals(); });

it('shows repeated skips, a stall count and a worker log link', async () => {
  const data = fixture(), base = data.decisions[2], openPane = vi.fn();
  data.decisions = [1, 2, 3, 4].map(hour => ({ ...base, title: 'Bet RQ-FAKE-123', at: `2026-10-31T0${hour}:00:00Z` }));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(data)));
  render(<FleetDecisionsPane {...{ visible: true, host: { openPane } } as unknown as PaneProps} />);
  const section = within(await screen.findByRole('region', { name: 'Repeated skips' }));
  const row = section.getByRole('listitem');
  expect(row).toHaveTextContent('Bet RQ-FAKE-123');
  expect(row).toHaveTextContent('skipped 4 ticks in a row since');
  expect(within(row).getByText('No seat')).toBeInTheDocument();
  expect(within(row).getByText((_, element) => element?.tagName === 'TIME')).toHaveAttribute('datetime', '2026-10-31T01:00:00Z');
  expect(screen.getByRole('status')).toHaveTextContent('No launches in the journal window; last skip: No seat · 1 bets skipped 3+ ticks in a row');
  fireEvent.click(within(row).getByRole('button', { name: 'Open log for RQ-FAKE-123' }));
  expect(openPane).toHaveBeenCalledWith('worker-log');
  expect(takeRequestedWorkerLogJob()).toBe('RQ-FAKE-123');
});

it('hides repeated skips when no item meets the threshold', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixture())));
  render(<FleetDecisionsPane {...{ visible: true } as PaneProps} />);
  await screen.findByText(/2 launched · 1 skipped · tick/);
  expect(screen.queryByRole('region', { name: 'Repeated skips' })).not.toBeInTheDocument();
});
