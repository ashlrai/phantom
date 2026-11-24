import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetUsagePane } from './FleetUsagePane.js';

const props = { visible: true } as PaneProps;
const HOUR = 60 * 60 * 1000;
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();

const accounts = () => ({
  sampledAt: inMs(-60_000),
  refreshing: false,
  accounts: [
    {
      id: 'claude-1', label: 'Claude Max', provider: 'claude', state: 'observed', authentication: 'signed-in',
      windows: [{ id: 'weekly', label: 'Weekly', usedPercent: 58, resetsAt: null, resetDescription: 'resets Thu at midnight', limitReached: false, measured: true }],
    },
    {
      id: 'codex-1', label: 'Codex Team', provider: 'codex', state: 'observed', authentication: 'signed-in',
      windows: [
        { id: 'primary', label: 'Primary', usedPercent: 32, resetsAt: inMs(3.5 * HOUR), limitReached: false, measured: true },
        { id: 'secondary', label: 'Secondary', usedPercent: 100, resetsAt: inMs(50.5 * HOUR), limitReached: true, measured: false },
        { id: 'spark', label: 'Spark', usedPercent: null, resetsAt: null, limitReached: false, measured: true },
      ],
    },
    {
      id: 'grok-1', label: 'Grok Heavy', provider: 'grok', state: 'observed', authentication: 'signed-in',
      windows: [{ id: 'weekly', label: 'Weekly', usedPercent: null, resetsAt: inMs(101 * HOUR), limitReached: false, measured: false }],
    },
  ],
});

function stub(body: { accounts?: unknown; runs?: unknown }) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/verse/accounts') && body.accounts) return Response.json(body.accounts);
    if (url.includes('/api/verse/fleet/runs') && body.runs) return Response.json(body.runs);
    return Response.json({}, { status: 404 });
  }));
}

beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('lines up every dated reset soonest first, each with its countdown and usage in words', async () => {
  stub({ accounts: accounts() });
  render(<FleetUsagePane {...props} />);
  const region = await screen.findByRole('region', { name: 'Resets ahead' });
  const rows = within(within(region).getByRole('list', { name: 'Resets ahead, soonest first' })).getAllByRole('listitem');
  expect(rows.map((row) => row.textContent)).toEqual([
    expect.stringMatching(/^Codex Team · Primaryin 3 h \d+ m · .+32% used$/),
    expect.stringMatching(/^Codex Team · Secondaryin 2 d 2 h · .+limit reached$/),
    expect.stringMatching(/^Grok Heavy · Weeklyin 4 d \d+ h · .+usage unknown$/),
  ]);
  expect(within(region).getByText(/^3 windows reset, the last in 4 d \d+ h; 1 flagged at a limit until its reset; 2 gave no time to place\.$/)).toBeInTheDocument();
});

it('puts the furthest reset at the end of the line and marks a flagged limit without relying on colour', async () => {
  stub({ accounts: accounts() });
  render(<FleetUsagePane {...props} />);
  const region = await screen.findByRole('region', { name: 'Resets ahead' });
  const rows = within(region).getAllByRole('listitem');
  expect(rows.map((row) => row.hasAttribute('data-limit'))).toEqual([false, true, false]);
  const lefts = rows.map((row) => parseFloat((row.querySelector('time')!.previousElementSibling!.lastElementChild as HTMLElement).style.left));
  expect(lefts[0]).toBeGreaterThan(3);
  expect(lefts[0]).toBeLessThan(4);
  expect(lefts[1]).toBeCloseTo(50, 0);
  expect(lefts[2]).toBe(100);
  expect(rows[1].querySelector('time')).toHaveAttribute('dateTime', expect.stringMatching(/^\d{4}-\d\d-\d\dT/));
});

it('names the windows that gave no instant instead of placing them', async () => {
  stub({ accounts: accounts() });
  render(<FleetUsagePane {...props} />);
  const region = await screen.findByRole('region', { name: 'Resets ahead' });
  expect(within(region).getByText(
    'Not on the line: Claude Max · Weekly (resets Thu at midnight), Codex Team · Spark (no reset time given).',
  )).toBeInTheDocument();
});

it("adds the fleet's Codex personal reading to the line when the fleet read carries its reset", async () => {
  stub({
    accounts: accounts(),
    runs: { v: 1, sources: {}, lanes: [], codexPersonal: { usedPct: 71, resetsAt: inMs(1.5 * HOUR), asOf: inMs(-60_000) } },
  });
  render(<FleetUsagePane {...props} />);
  const region = await screen.findByRole('region', { name: 'Resets ahead' });
  expect(await within(region).findByText('Codex personal · fleet reading')).toBeInTheDocument();
  expect(within(region).getAllByRole('listitem')[0].textContent).toMatch(/^Codex personal · fleet readingin 1 h \d+ m · .+71% used$/);
});

it('draws no line when no account gave a reset as a date and time', async () => {
  const body = accounts();
  stub({ accounts: { accounts: [body.accounts[0]] } });
  render(<FleetUsagePane {...props} />);
  expect(await screen.findByText('Next reset: no account gave one as a date and time.')).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Resets ahead' })).not.toBeInTheDocument();
});
