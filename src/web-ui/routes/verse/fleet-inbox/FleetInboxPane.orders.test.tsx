import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { openDockPane } from '../dock/dock-store.js';
import { FleetInboxPane } from './FleetInboxPane.js';

vi.mock('../fleet-job-log/worker-log-selection.js', () => ({ requestWorkerLogJob: vi.fn() }));
vi.mock('../dock/dock-store.js', () => ({ openDockPane: vi.fn() }));
const props: PaneProps = {
  paneId: 'fleet-inbox', sessionId: null, session: null, visible: true, presentation: 'column', roots: [], events: [], turnFiles: [],
  requests: { terminal: null, preview: null, diff: null },
  host: { addToMessage: vi.fn(), sendToChat: vi.fn(), openPane: vi.fn(), closePane: vi.fn(), openTerminal: vi.fn(), openTerminalBelow: vi.fn(), openDiff: vi.fn(), openSession: vi.fn() },
};
const entries = [{ at: '2026-10-31 00:13', source: 'Phantom desktop', priority: 'P0', text: 'Ship this' },
  { at: '2026-10-31 00:14', source: 'Phantom desktop', priority: 'P0', text: 'No jobs' }];
const jobs = [
  { id: 'RQ-PHX-PUBLISH', lane: 'work', state: 'published', url: 'https://github.com/ashlrai/phantom/pull/1712' },
  { id: 'RQ-PHX-RUNNING', lane: 'work', state: 'launched', url: null },
  { id: 'RQ-PHX-QUEUED', lane: 'work', state: 'queued', url: null },
];
const trace = { v: 1, generatedAt: 'now', sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' },
  orders: [{ at: '2026-10-31 00:13 ET', source: 'desktop', key: '10-31 00:13', jobs }] };
function mockFetch(status = 200, data: unknown = trace) {
  const fetcher = vi.fn(async (url: RequestInfo | URL) => String(url).includes('/leader/orders')
    ? Response.json(status === 200 ? data : { error: 'trace unavailable' }, { status })
    : Response.json({ v: 1, sourceState: 'healthy', entries }));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
beforeEach(() => { sessionStorage.clear(); evictAll(); vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('shows jobs with a PR link and opens a launched worker log', async () => {
  mockFetch();
  render(<FleetInboxPane {...props} />);
  const row = (await screen.findByText('Ship this')).closest('article')!;
  expect(await within(row).findByText('3 jobs')).toBeInTheDocument();
  expect(within(row).getByRole('link', { name: 'PR #1712' })).toHaveAttribute('href', jobs[0]!.url);
  expect(within(row).getByRole('link', { name: 'PR #1712' })).toHaveAttribute('target', '_blank');
  expect(within(row).getByText('running')).toBeInTheDocument();
  expect(within(row).queryByRole('button', { name: /RQ-PHX-QUEUED/ })).not.toBeInTheDocument();
  fireEvent.click(within(row).getByRole('button', { name: 'Open log for RQ-PHX-RUNNING' }));
  expect(requestWorkerLogJob).toHaveBeenCalledWith('RQ-PHX-RUNNING');
  expect(openDockPane).toHaveBeenCalledWith('worker-log');
  expect(screen.getByText('No jobs').closest('article')!.querySelector('[class*="jobs"]')).toBeNull();
});

it.each([404, 500])('quietly ignores a trace HTTP %s', async status => {
  const fetcher = mockFetch(status);
  render(<FleetInboxPane {...props} />);
  await screen.findByText('Ship this');
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).includes('/leader/orders'))).toBe(true));
  expect(document.querySelector('[class*="jobs"]')).toBeNull();
  expect(screen.queryByText(/trace unavailable|not in this build/i)).not.toBeInTheDocument();
});

it('caps chips at six and does not fetch the trace while hidden', async () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ ...jobs[2]!, id: `RQ-PHX-${i}` }));
  const fetcher = mockFetch(200, { ...trace, orders: [{ ...trace.orders[0], jobs: many }] });
  const view = render(<FleetInboxPane {...props} visible={false} />);
  await screen.findByText('Ship this');
  expect(fetcher.mock.calls.some(([url]) => String(url).includes('/leader/orders'))).toBe(false);
  view.rerender(<FleetInboxPane {...props} visible />);
  expect(await screen.findByText('8 jobs')).toBeInTheDocument();
  expect(screen.getByText('+2 more')).toBeInTheDocument();
  expect(screen.queryByText('RQ-PHX-6')).not.toBeInTheDocument();
});
