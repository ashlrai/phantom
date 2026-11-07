import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { openDockPane } from '../dock/dock-store.js';
import { agentBusMissing } from '../fleet-bus/agent-bus-queries.js';
import { takeBusPostRequest } from '../fleet-bus/bus-post-request.js';
import { JobDetailSheet } from './JobDetailSheet.js';

vi.mock('../dock/dock-store.js', () => ({ openDockPane: vi.fn() }));
vi.mock('../fleet-bus/agent-bus-queries.js', async importOriginal => ({
  ...await importOriginal<typeof import('../fleet-bus/agent-bus-queries.js')>(), agentBusMissing: vi.fn(() => false),
}));
const url = 'https://github.com/example/repo/pull/12';
const detail = { schema: 'fleet.job.v1', job: 'RQ-PHX-FOO', state: 'running', lane: 'test',
  publish: { prUrl: url }, log: { source: 'live', tail: ['private log text'] },
  sources: { launch: 'healthy', base: 'healthy', meta: 'healthy', publish: 'healthy', log: 'healthy' } };
beforeEach(() => { evictAll(); vi.clearAllMocks(); vi.mocked(agentBusMissing).mockReturnValue(false); vi.stubGlobal('fetch', vi.fn(async () => Response.json(detail))); });
afterEach(() => { takeBusPostRequest(); vi.unstubAllGlobals(); evictAll(); });

it('requests a job-addressed bus post and opens the pane', async () => {
  const close = vi.fn();
  render(<JobDetailSheet job="RQ-PHX-FOO" onClose={close} />);
  await screen.findByRole('link', { name: 'Open PR #12' });
  fireEvent.click(screen.getByRole('button', { name: 'Tell on bus' }));
  expect(takeBusPostRequest()).toEqual({ to: 'RQ-PHX-FOO', quote: `RQ-PHX-FOO · running · ${url}`, text: '' });
  expect(openDockPane).toHaveBeenCalledWith('fleet-bus');
  expect(close).toHaveBeenCalledOnce();
});

it('disables the action when the durable bus is missing', () => {
  vi.mocked(agentBusMissing).mockReturnValue(true);
  render(<JobDetailSheet job="RQ-PHX-FOO" onClose={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Tell on bus' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Tell on bus' })).toHaveAttribute('title', 'Durable bus is missing');
});
