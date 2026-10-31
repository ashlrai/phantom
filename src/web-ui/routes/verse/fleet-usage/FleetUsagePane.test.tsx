import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetUsagePane } from './FleetUsagePane.js';

const props = { visible: true } as PaneProps;

const HOUR = 60 * 60 * 1000;
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();

const accountsBody = () => ({
  sampledAt: '2026-10-31T12:00:00Z',
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
      ],
    },
    {
      id: 'grok-1', label: 'Grok', provider: 'grok', state: 'signed-out', authentication: 'signed-out',
      reason: 'reconnect through `ashlr resources`', windows: [],
    },
  ],
});

const runsBody = () => ({
  v: 1,
  generatedAt: '2026-10-31T12:00:00Z',
  sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lanes: [
    { lane: 'beta', running: 1, target: 2, queued: 0, held: false, heldReason: null, tokensLastHour: 500, merged24h: null, mergeRate24h: null },
    { lane: 'alpha', running: 3, target: 4, queued: 0, held: false, heldReason: null, tokensLastHour: 2500, merged24h: null, mergeRate24h: null },
    { lane: 'idle', running: 0, target: 1, queued: 0, held: false, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null },
  ],
  codexPersonal: { usedPct: 44, resetsAt: inMs(2.5 * HOUR), asOf: inMs(-60_000) },
});

function stubFetch(handler: (url: string) => Response) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => handler(String(input))));
}
const stubOk = () => stubFetch((url) =>
  url.includes('/api/verse/accounts') ? Response.json(accountsBody())
    : url.includes('/api/verse/fleet/runs') ? Response.json(runsBody())
      : Response.json({}, { status: 404 }));

beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('renders a weekly-only Claude account as exactly one meter, with no 5h text anywhere', async () => {
  stubFetch((url) =>
    url.includes('/api/verse/accounts')
      ? Response.json({ accounts: [accountsBody().accounts[0]] })
      : Response.json({}, { status: 404 }));
  const { container } = render(<FleetUsagePane {...props} />);
  expect(await screen.findByText('Claude Max')).toBeInTheDocument();
  expect(screen.getAllByRole('meter')).toHaveLength(1);
  expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '58');
  expect(screen.getByText('resets Thu at midnight')).toBeInTheDocument();
  expect(container.textContent).not.toMatch(/5\s?h|five hour/i);
});

it('renders meters per reported window, flags limits, shows reasons, codex personal and the lane table', async () => {
  stubOk();
  const { container } = render(<FleetUsagePane {...props} />);
  expect(await screen.findByText('Claude Max')).toBeInTheDocument();

  // Provider order — Claude, Codex, Grok — then the fleet snapshot's own figure.
  const text = container.textContent ?? '';
  for (const [a, b] of [['Claude Max', 'Codex Team'], ['Codex Team', 'Grok'], ['Grok', 'Codex personal']]) {
    expect(text.indexOf(a), `${a} before ${b}`).toBeLessThan(text.indexOf(b));
  }
  // Exactly one meter per measured window the provider reported.
  expect(within(screen.getByText('Claude Max').closest('li') as HTMLElement).getAllByRole('meter')).toHaveLength(1);
  const codexRow = screen.getByText('Codex Team').closest('li') as HTMLElement;
  expect(within(codexRow).getAllByRole('meter')).toHaveLength(1);
  expect(within(codexRow).getByText('limit reached')).toBeInTheDocument();
  // The flagged window is a flag, not a measurement: no 100% anywhere.
  expect(screen.getAllByRole('meter').map((m) => m.getAttribute('aria-valuenow'))).toEqual(['58', '32', '44']);
  expect(container.textContent).not.toContain('100%');
  expect(screen.getByText('reconnect through `ashlr resources`')).toBeInTheDocument();
  expect(screen.getByText(/resets in 2 h \d+ m/)).toBeInTheDocument();
  expect(screen.getByText(/as of \d+m ago/)).toBeInTheDocument();

  const laneRows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
  expect(laneRows.map((row) => within(row).getAllByRole('cell').map((cell) => cell.textContent)))
    .toEqual([['alpha', '3/4', '2.5k'], ['beta', '1/2', '500'], ['idle', '0/1', '—']]);
});

it('reports degraded fleet sources and the collector note as notices', async () => {
  const runs = runsBody();
  runs.sources.codex = 'degraded';
  const accounts = { ...accountsBody(), collector: { owner: 'another-collector' } };
  stubFetch((url) =>
    url.includes('/api/verse/accounts') ? Response.json(accounts)
      : url.includes('/api/verse/fleet/runs') ? Response.json(runs)
        : Response.json({}, { status: 404 }));
  render(<FleetUsagePane {...props} />);
  expect(await screen.findByText('Fleet sources degraded: codex.')).toBeInTheDocument();
  expect(screen.getByText(/quota-refresh lease/)).toBeInTheDocument();
});

it('shows Usage not in this build when both reads are missing', async () => {
  stubFetch(() => Response.json({}, { status: 404 }));
  render(<FleetUsagePane {...props} />);
  expect(await screen.findByText('Usage not in this build')).toBeInTheDocument();
});

it('keeps rendering one source with a notice when the other is missing', async () => {
  stubFetch((url) =>
    url.includes('/api/verse/fleet/runs') ? Response.json(runsBody()) : Response.json({}, { status: 404 }));
  render(<FleetUsagePane {...props} />);
  expect(await screen.findByText('Tokens last hour')).toBeInTheDocument();
  expect(screen.getByText(/does not expose \/api\/verse\/accounts/)).toBeInTheDocument();
});

it('polls accounts every 60 s and runs every 10 s, only while visible', async () => {
  vi.useFakeTimers();
  const calls = { accounts: 0, runs: 0 };
  stubFetch((url) => {
    if (url.includes('/api/verse/accounts')) { calls.accounts += 1; return Response.json(accountsBody()); }
    if (url.includes('/api/verse/fleet/runs')) { calls.runs += 1; return Response.json(runsBody()); }
    return Response.json({}, { status: 404 });
  });
  const view = render(<FleetUsagePane {...props} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(calls).toEqual({ accounts: 1, runs: 1 });
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(calls).toEqual({ accounts: 1, runs: 2 });
  await act(async () => { await vi.advanceTimersByTimeAsync(50_000); });
  expect(calls).toEqual({ accounts: 2, runs: 7 });
  await act(async () => { view.rerender(<FleetUsagePane {...props} visible={false} />); });
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
  expect(calls).toEqual({ accounts: 2, runs: 7 });
});
