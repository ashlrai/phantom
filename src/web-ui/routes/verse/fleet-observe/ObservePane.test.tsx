import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { ObservePane } from './ObservePane.js';

const openPane = vi.fn();
const props = { visible: true, host: { openPane } } as unknown as PaneProps;
const runs = () => ({
  v: 1, generatedAt: new Date().toISOString(),
  lanes: [{ lane: 'claude', running: 1, target: 2, queued: 0, held: false, heldReason: null, tokensLastHour: 4200 },
    { lane: 'devin', running: 0, target: 1, queued: 2, held: true, heldReason: 'quota', tokensLastHour: null }],
  workers: [{ job: 'job-alpha', repo: 'a/b', lane: 'claude', tier: 'work', ageSeconds: 120 }],
  mergesLastHour: { items: [{ repo: 'a/b', number: 9, title: 'ship it', mergedAt: new Date().toISOString() }] },
});
const accounts = { sampledAt: '2026-10-31T12:00:00Z', refreshing: false, accounts: [{ id: 'claude-1', label: 'Claude Max', provider: 'claude', state: 'observed', authentication: 'signed-in',
  windows: [{ id: 'weekly', label: 'Weekly', usedPercent: 92, resetsAt: null, resetDescription: 'resets Thu', limitReached: false, measured: true }] }] };
const bus = { v: 1, status: 'ok', nextCursor: 2, messages: [{ cursor: 1, receivedAt: 1, envelope: { id: 'm1', from: 'claude-1', to: 'codex-2', priority: 'P2', ttl: 1000, body: { text: 'handing off' } } }] };

function stub(map: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const hit = Object.entries(map).find(([path]) => url.includes(path));
    return hit ? Response.json(hit[1]) : new Response('{}', { status: 404 });
  }));
}
beforeEach(() => { evictAll(); openPane.mockClear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('renders every region from real snapshot data and opens a session log', async () => {
  stub({ '/api/verse/fleet/runs': runs(), '/api/verse/accounts': accounts, '/api/verse/agent-bus': bus });
  render(<ObservePane {...props} />);
  const sessions = await screen.findByRole('region', { name: 'Sessions' });
  expect(within(sessions).getByText('4,200')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /1 running · 2 lanes · 1 merged/ })).toBeInTheDocument();
  expect(await screen.findByRole('meter', { name: 'Claude Max Weekly used' })).toHaveAttribute('aria-valuenow', '92');
  expect(within(screen.getByRole('region', { name: 'Merge ticker' })).getByRole('link', { name: 'a/b #9' })).toHaveAttribute('href', 'https://github.com/a/b/pull/9');
  expect(await within(screen.getByRole('region', { name: 'Agent comms' })).findByText(/handing off/)).toBeInTheDocument();
  expect(within(screen.getByRole('region', { name: 'Incidents' })).getByText('devin held: quota')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Open log for job-alpha' }));
  expect(openPane).toHaveBeenCalledWith('worker-log');
});

it('says so when the snapshot route is missing', async () => {
  stub({});
  render(<ObservePane {...props} />);
  expect(await screen.findByText(/not in this build|could not be read/)).toBeInTheDocument();
});
