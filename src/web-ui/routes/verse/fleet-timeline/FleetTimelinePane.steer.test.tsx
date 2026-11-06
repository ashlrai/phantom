import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { fleetRunsFixture } from '../fleet/fleet-runs-fixtures.test-support.js';
import { openInterjectDialog } from '../fleet/interject-dialog-store.js';
import { FleetTimelinePane } from './FleetTimelinePane.js';

vi.mock('../fleet/interject-dialog-store.js', () => ({ openInterjectDialog: vi.fn() }));

const worker = (job: string, ageSeconds: number) => ({ job, ageSeconds, lane: 'devin', repo: 'fake/repo', tier: 'mid' });
const serve = (workers: ReturnType<typeof worker>[]) => vi.stubGlobal('fetch', vi.fn(async () => Response.json(fleetRunsFixture({ workers, claudeLane: null }))));

beforeEach(() => { evictAll(); localStorage.clear(); vi.clearAllMocks(); });
afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('steers the longest stuck worker from the header and its grouped lane', async () => {
  serve([worker('RQ-PHX-EXAMPLE1', 62 * 60), worker('RQ-PHX-FRESH', 10 * 60)]);
  render(<FleetTimelinePane visible />);
  fireEvent.click(await screen.findByRole('button', { name: 'Steer RQ-PHX-EXAMPLE1' }));
  expect(openInterjectDialog).toHaveBeenCalledWith({ prefill: 'Re RQ-PHX-EXAMPLE1 (devin): ' });
  expect(screen.queryByRole('button', { name: 'Steer RQ-PHX-FRESH' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Group by lane' }));
  const lane = screen.getByRole('region', { name: 'devin lane' });
  expect(lane).toHaveTextContent('Stuck: RQ-PHX-EXAMPLE1 62 m');
  fireEvent.click(within(lane).getByRole('button', { name: 'Steer RQ-PHX-EXAMPLE1' }));
  expect(openInterjectDialog).toHaveBeenCalledTimes(2);
  expect(openInterjectDialog).toHaveBeenLastCalledWith({ prefill: 'Re RQ-PHX-EXAMPLE1 (devin): ' });
  expect(within(lane).queryByRole('button', { name: 'Steer RQ-PHX-FRESH' })).not.toBeInTheDocument();
});

it('shows only the five longest valid stuck workers and a remainder count', async () => {
  serve([...Array.from({ length: 7 }, (_, i) => worker(`RQ-PHX-JOB${i}`, 3000 + i * 60)), worker('bad id', 6000)]);
  render(<FleetTimelinePane visible />);
  await screen.findByRole('button', { name: 'bad id' });
  expect(screen.queryByRole('button', { name: 'Steer bad id' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Group by lane' }));
  const lane = screen.getByRole('region', { name: 'devin lane' });
  expect(within(lane).getAllByRole('button', { name: /^Steer / })).toHaveLength(5);
  expect(within(lane).getByText('+2 more')).toBeInTheDocument();
  expect(within(lane).queryByRole('button', { name: 'Steer RQ-PHX-JOB0' })).not.toBeInTheDocument();
  expect(within(lane).getByRole('button', { name: 'Steer RQ-PHX-JOB6' })).toBeInTheDocument();
});
