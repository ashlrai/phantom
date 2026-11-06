import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { fleetRunsFixture, withWorker } from '../fleet/fleet-runs-fixtures.test-support.js';
import { openDockPane } from '../dock/dock-store.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { FleetTimelinePane } from './FleetTimelinePane.js';

vi.mock('../dock/dock-store.js', () => ({ openDockPane: vi.fn() }));
vi.mock('../fleet-job-log/worker-log-selection.js', () => ({ requestWorkerLogJob: vi.fn() }));

beforeEach(() => {
  evictAll(); localStorage.clear(); vi.clearAllMocks();
  const fixture = withWorker(fleetRunsFixture({ claudeLane: null }), { job: 'RQ-FAKE-JOB2', repo: 'fake/repo', lane: 'devin', tier: 'mid', ageSeconds: 3000 });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixture)));
});
afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('toggles grouped lanes, persists the choice, and opens a grouped worker log', async () => {
  const view = render(<FleetTimelinePane visible />);
  await screen.findByRole('button', { name: 'codex-personal 3/4: RQ-FAKE-JOB1' });
  const toggle = screen.getByRole('button', { name: 'Group by lane' });
  expect(toggle).toHaveAttribute('aria-pressed', 'false');
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-pressed', 'true');
  expect(localStorage.getItem('phantom.timeline.group-by-lane.v1')).toBe('true');
  const codex = screen.getByRole('region', { name: 'codex-personal lane' });
  const devin = screen.getByRole('region', { name: 'devin lane' });
  expect(codex).toHaveTextContent('codex-personal · 1 worker · median 2 m');
  expect(devin).toHaveTextContent('devin · 1 worker · 1 stuck · median 50 m');
  fireEvent.click(within(devin).getByRole('button', { name: 'RQ-FAKE-JOB2: RQ-FAKE-JOB2' }));
  expect(requestWorkerLogJob).toHaveBeenCalledWith('RQ-FAKE-JOB2');
  expect(openDockPane).toHaveBeenCalledWith('worker-log');
  view.unmount();
  render(<FleetTimelinePane visible />);
  expect(screen.getByRole('button', { name: 'Group by lane' })).toHaveAttribute('aria-pressed', 'true');
  expect(await screen.findByRole('region', { name: 'devin lane' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Group by lane' }));
  expect(localStorage.getItem('phantom.timeline.group-by-lane.v1')).toBe('false');
  expect(screen.queryByRole('region', { name: 'devin lane' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'devin 1/2: RQ-FAKE-JOB2' })).toBeInTheDocument();
});
