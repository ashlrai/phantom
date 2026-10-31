import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { openDockPane } from '../dock/dock-store.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { RunsGraph } from './RunsGraph.js';

vi.mock('../dock/dock-store.js', () => ({ openDockPane: vi.fn() }));
vi.mock('../fleet-job-log/worker-log-selection.js', () => ({ requestWorkerLogJob: vi.fn() }));

beforeEach(() => {
  evictAll();
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    v: 1, workers: [{ job: 'RQ-PHX-FOO', lane: 'codex', repo: 'ashlrai/phantom' }], leaders: [],
    lanes: [{ lane: 'codex', running: 1, target: 2 }],
    mergesLastHour: { count: 1, items: [{ repo: 'ashlrai/phantom', number: 1719, title: 'A merge' }] }, switches: [],
  })));
});
afterEach(() => { vi.unstubAllGlobals(); evictAll(); });

it('opens a worker log, a PR, and the lanes pane from selected nodes', async () => {
  render(<RunsGraph />);
  const job = await screen.findByRole('button', { name: 'Inspect workspace node run:RQ-PHX-FOO' });
  expect(screen.queryByRole('group', { name: 'Selected node' })).not.toBeInTheDocument();
  fireEvent.click(job);
  let actions = screen.getByRole('group', { name: 'Selected node' });
  expect(actions).toHaveTextContent('RQ-PHX-FOO');
  fireEvent.click(within(actions).getByRole('button', { name: 'Open worker log' }));
  expect(requestWorkerLogJob).toHaveBeenCalledWith('RQ-PHX-FOO');
  expect(openDockPane).toHaveBeenCalledWith('worker-log');
  fireEvent.click(job);
  expect(screen.queryByRole('group', { name: 'Selected node' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Inspect workspace node merged:["ashlrai/phantom",1719]' }));
  actions = screen.getByRole('group', { name: 'Selected node' });
  expect(within(actions).getByRole('link', { name: 'Open PR #1719' })).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/pull/1719');
  expect(within(actions).getByRole('link')).toHaveAttribute('target', '_blank');
  expect(within(actions).getByRole('link')).toHaveAttribute('rel', 'noopener noreferrer');
  fireEvent.click(screen.getByRole('button', { name: 'Inspect workspace node lane:codex' }));
  fireEvent.click(within(screen.getByRole('group', { name: 'Selected node' })).getByRole('button', { name: 'Open Lanes pane' }));
  expect(openDockPane).toHaveBeenCalledWith('fleet-lanes');
});
