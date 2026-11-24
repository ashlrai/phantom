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
        { id: 'secondary', label: 'Secondary', usedPercent: 100, resetsAt: null, limitReached: true, measured: false },
        { id: 'spark', label: 'Spark', usedPercent: null, resetsAt: null, limitReached: false, measured: true },
      ],
    },
    { id: 'grok-1', label: 'Grok', provider: 'grok', state: 'signed-out', authentication: 'signed-out', windows: [] },
  ],
});

const runs = () => ({
  v: 1,
  sources: {},
  lanes: [
    { lane: 'codex', running: 3, target: 4, tokensLastHour: 2500 },
    { lane: 'beta', running: 1, target: 2, tokensLastHour: 500 },
    { lane: 'idle', running: 0, target: 1, tokensLastHour: null },
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

it('heads the board with where the accounts stand and the next reset', async () => {
  stub({ accounts: accounts() });
  render(<FleetUsagePane {...props} />);
  expect(await screen.findByText('3 accounts: 1 flagged at a limit, 1 not readable.')).toBeInTheDocument();
  expect(screen.getByText(/^Next reset: Codex Team, Primary, in 3 h \d+ m\. Accounts read /)).toBeInTheDocument();
});

it('says no reset came as a date and time instead of deriving one from provider prose', async () => {
  const body = accounts();
  stub({ accounts: { accounts: [body.accounts[0]] } });
  render(<FleetUsagePane {...props} />);
  expect(await screen.findByText('1 account read, none flagged at a limit.')).toBeInTheDocument();
  expect(screen.getByText('Next reset: no account gave one as a date and time.')).toBeInTheDocument();
});

it('draws each account with its provider mark and its state word beside the name', async () => {
  stub({ accounts: accounts() });
  render(<FleetUsagePane {...props} />);
  const mark = (label: string) => (screen.getByText(label).closest('li') as HTMLElement).querySelector('svg')?.getAttribute('data-provider');
  await screen.findByText('Claude Max');
  expect(mark('Claude Max')).toBe('claude');
  expect(mark('Codex Team')).toBe('codex');
  const grok = screen.getByText('Grok').closest('li') as HTMLElement;
  expect(grok).toHaveAttribute('data-standing', 'unread');
  // The state is said once, by the name; with no provider reason there is nothing to repeat below it.
  expect(within(grok).getAllByText('signed out')).toHaveLength(1);
  expect(screen.getByText('Codex Team').closest('li')).toHaveAttribute('data-standing', 'limit');
});

it('shows a machine-readable reset as a local time and marks an unmeasured window as unknown', async () => {
  const body = accounts();
  stub({ accounts: body });
  render(<FleetUsagePane {...props} />);
  const codex = (await screen.findByText('Codex Team')).closest('li') as HTMLElement;
  const time = codex.querySelector('time');
  expect(time).toHaveAttribute('dateTime', (body.accounts[1].windows[0] as { resetsAt: string }).resetsAt);
  expect(time?.textContent).toMatch(/\d/);
  const spark = within(codex).getByRole('meter', { name: 'Codex Team Spark used' });
  expect(spark).toHaveAttribute('data-unread');
  expect(spark).toHaveAttribute('aria-valuetext', 'unknown');
  expect(spark).not.toHaveAttribute('aria-valuenow');
  expect(within(codex).getByRole('meter', { name: 'Codex Team Primary used' })).not.toHaveAttribute('data-unread');
  // Claude's reset is provider prose with no instant, so no clock time is derived for it.
  expect((screen.getByText('Claude Max').closest('li') as HTMLElement).querySelector('time')).toBeNull();
});

it('totals lane tokens from the lanes that reported and scales each bar to the busiest', async () => {
  stub({ runs: runs() });
  render(<FleetUsagePane {...props} />);
  expect(await screen.findByText('3k across 2 lanes; 1 with no reading. Bars are each lane against the busiest.')).toBeInTheDocument();
  const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
  expect(rows.map((row) => row.style.getPropertyValue('--share'))).toEqual(['100%', '20%', '']);
  // Only a lane named after a known brand gets a mark.
  expect(rows.map((row) => row.querySelector('svg')?.getAttribute('data-provider') ?? null)).toEqual(['codex', null, null]);
});

it('says no lane reported tokens rather than totalling to zero', async () => {
  stub({ runs: { v: 1, sources: {}, lanes: [{ lane: 'idle', running: 0, target: 1, tokensLastHour: null }] } });
  render(<FleetUsagePane {...props} />);
  expect(await screen.findByText('No lane reported a token figure.')).toBeInTheDocument();
});
