import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetDecisionsPane } from './FleetDecisionsPane.js';
import { fixture } from './fixtures.js';

vi.mock('../fleet-job-log/worker-log-selection.js', () => ({ requestWorkerLogJob: vi.fn() }));

beforeEach(() => { evictAll(); vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('links references in decision and held titles and reasons', async () => {
  const data = fixture();
  data.decisions[0].title = 'Investigate RQ-PHX-EXAMPLE1';
  data.decisions[2].skipReason = 'Waiting for RQ-PHX-EXAMPLE2';
  data.held[0].title = 'Follow up #1501';
  data.held[0].reason = 'Waiting for #1500';
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(data)));
  const openPane = vi.fn();
  const props = { visible: true, host: { openPane } } as unknown as PaneProps;
  render(<FleetDecisionsPane {...props} />);

  fireEvent.click(await screen.findByRole('button', { name: 'Open log for RQ-PHX-EXAMPLE1' }));
  expect(requestWorkerLogJob).toHaveBeenCalledWith('RQ-PHX-EXAMPLE1');
  expect(openPane).toHaveBeenCalledWith('worker-log');
  fireEvent.click(screen.getByRole('button', { name: 'Open log for RQ-PHX-EXAMPLE2' }));
  expect(requestWorkerLogJob).toHaveBeenLastCalledWith('RQ-PHX-EXAMPLE2');
  expect(openPane).toHaveBeenCalledTimes(2);

  const held = within(screen.getByRole('list', { name: 'Held items' }));
  expect(held.getByRole('link', { name: '#1500' })).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/pull/1500');
  expect(held.getByRole('link', { name: '#1501' })).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/pull/1501');
  expect(within(screen.getByRole('list', { name: 'Decisions' })).getByText(/ashlrai\/phantom · Second/)).toHaveTextContent('ashlrai/phantom · Second');
});
