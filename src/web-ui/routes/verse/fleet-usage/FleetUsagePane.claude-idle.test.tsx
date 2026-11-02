import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetUsagePane } from './FleetUsagePane.js';

const props = { visible: true } as PaneProps;

function stubFetch(claudeLane: string) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/verse/accounts')) return Response.json({ accounts: [{
      id: 'fake-claude', label: 'Claude Max', provider: 'claude', state: 'observed', authentication: 'signed-in',
      windows: [{ id: 'weekly', label: 'Weekly', usedPercent: 3, measured: true, limitReached: false, resetsAt: null }],
    }] });
    if (url.includes('/api/verse/fleet/runs')) return Response.json({
      claudeLane, lanes: [{ lane: 'claude', running: 0, target: 12, tokensLastHour: 0 }],
    });
    return Response.json({}, { status: 404 });
  }));
}

beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('shows the outage and incident chip under the Claude account', async () => {
  stubFetch('down token rejected');
  render(<FleetUsagePane {...props} />);
  const message = await screen.findByText(/Lane down · 12 slots idle · 97% of the weekly window unused/);
  expect(message).toHaveAttribute('data-tone', 'warn');
  const row = screen.getByText('Claude Max').closest('li') as HTMLElement;
  expect(within(row).getByText('Incident')).toBeInTheDocument();
  expect(row).toContainElement(message);
});

it('renders neither the outage nor the chip when healthy', async () => {
  stubFetch('healthy');
  render(<FleetUsagePane {...props} />);
  await screen.findByText('Tokens last hour');
  expect(screen.queryByText(/Lane down/)).not.toBeInTheDocument();
  expect(screen.queryByText('Incident')).not.toBeInTheDocument();
});
