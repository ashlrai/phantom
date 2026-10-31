import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { openDockPane } from '../dock/dock-store.js';
import { fleetRunsFixture } from '../fleet/fleet-runs-fixtures.test-support.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { FleetLanesPane } from './FleetLanesPane.js';

vi.mock('../dock/dock-store.js', () => ({ openDockPane: vi.fn() }));
vi.mock('../fleet-job-log/worker-log-selection.js', () => ({ requestWorkerLogJob: vi.fn() }));

const workers = Array.from({ length: 14 }, (_, i) => ({
  job: `RQ-PHX-WORKER${i}`, repo: 'example/repo', lane: 'codex', tier: 'work', ageSeconds: i,
}));

beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('expands and collapses the worker list and opens an expanded worker log', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fleetRunsFixture({ claudeLane: null, lanes: [], workers }))));
  render(<FleetLanesPane visible />);
  const showMore = await screen.findByRole('button', { name: 'Show 2 more' });
  const section = screen.getByRole('heading', { name: 'Workers' }).parentElement!;
  expect(within(section).getAllByRole('listitem')).toHaveLength(12);
  expect(showMore).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(showMore);
  expect(within(section).getAllByRole('listitem')).toHaveLength(14);
  const showFewer = within(section).getByRole('button', { name: 'Show fewer' });
  expect(showFewer).toHaveAttribute('aria-expanded', 'true');
  fireEvent.click(within(section).getByRole('button', { name: 'Open log for RQ-PHX-WORKER0' }));
  expect(requestWorkerLogJob).toHaveBeenCalledExactlyOnceWith('RQ-PHX-WORKER0');
  expect(openDockPane).toHaveBeenCalledExactlyOnceWith('worker-log');
  fireEvent.click(showFewer);
  expect(within(section).getAllByRole('listitem')).toHaveLength(12);
  expect(within(section).queryByRole('button', { name: 'Open log for RQ-PHX-WORKER0' })).toBeNull();
});

it('does not open logs for invalid job IDs', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fleetRunsFixture({ claudeLane: null, lanes: [], workers: [{ ...workers[0]!, job: '../bad' }] }))));
  render(<FleetLanesPane visible />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open log for ../bad' }));
  expect(requestWorkerLogJob).not.toHaveBeenCalled();
  expect(openDockPane).not.toHaveBeenCalled();
});
