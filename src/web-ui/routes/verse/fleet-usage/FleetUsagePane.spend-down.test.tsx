import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetUsagePane } from './FleetUsagePane.js';

const props = { visible: true } as PaneProps;
const HOUR = 60 * 60 * 1000;
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();

const account = (id: string, label: string, usedPercent: number | null, resetsAt: string | null, measured = true) => ({
  id, label, provider: 'codex', state: 'observed', authentication: 'signed-in',
  windows: [{ id: 'weekly', label: 'Weekly', usedPercent, resetsAt, limitReached: false, measured }],
});

function stubAccounts(accounts: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) =>
    String(input).includes('/api/verse/accounts') ? Response.json({ accounts }) : Response.json({}, { status: 404 })));
}

beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('names the waste-risk windows, capped at four with a +N more tail', async () => {
  stubAccounts([
    account('a', 'Fake Alpha', 38, inMs(30 * HOUR + 60_000)),
    account('b', 'Fake Bravo', 60, inMs(12 * HOUR + 60_000)),
    account('c', 'Fake Charlie', 10, inMs(20 * HOUR)),
    account('d', 'Fake Delta', 10, inMs(21 * HOUR)),
    account('e', 'Fake Echo', 10, inMs(22 * HOUR)),
    account('f', 'Fake Foxtrot', 99, inMs(5 * HOUR)),
  ]);
  render(<FleetUsagePane {...props} />);
  const strip = await screen.findByText(/^Spend before reset:/);
  expect(strip.textContent).toMatch(/Fake Bravo \(Weekly\) 40% left, resets in 12 h/);
  expect(strip.textContent).toMatch(/Fake Charlie \(Weekly\) 90% left, resets in 19 h/);
  // Soonest four are shown; the 30 h window is the "+1 more", and a 1%-left window is not at risk at all.
  expect(strip.textContent).not.toContain('Fake Alpha');
  expect(strip.textContent).not.toContain('Fake Foxtrot');
  expect(strip.textContent).toMatch(/\+1 more$/);
  expect(strip.textContent?.split(' · ')).toHaveLength(5);
});

it('says the windows are on track when none is at risk', async () => {
  stubAccounts([account('a', 'Fake Alpha', 90, inMs(10 * HOUR)), account('b', 'Fake Bravo', 10, inMs(200 * HOUR))]);
  render(<FleetUsagePane {...props} />);
  expect(await screen.findByText('All measured windows are on track to be used.')).toBeInTheDocument();
  expect(screen.queryByText(/Spend before reset/)).toBeNull();
});

it('renders nothing for the strip when no window is measured with a future reset', async () => {
  stubAccounts([account('a', 'Fake Alpha', null, inMs(10 * HOUR), false), account('b', 'Fake Bravo', 10, null)]);
  render(<FleetUsagePane {...props} />);
  expect(await screen.findByText('Fake Alpha')).toBeInTheDocument();
  expect(screen.queryByText(/Spend before reset/)).toBeNull();
  expect(screen.queryByText(/on track to be used/)).toBeNull();
});
