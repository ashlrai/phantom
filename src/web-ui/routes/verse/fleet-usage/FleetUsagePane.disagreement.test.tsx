import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetUsagePane } from './FleetUsagePane.js';

const props = { visible: true } as PaneProps;

function stubReads(accountPct: number) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/verse/accounts')) return Response.json({
      accounts: [
        { id: 'team', label: 'Codex Team', provider: 'codex', state: 'observed', observedAt: '2026-10-31T11:00:00Z', windows: [{ id: 'weekly', label: 'Weekly', usedPercent: 50, measured: true }] },
        { id: 'personal', label: 'Codex Personal', provider: 'codex', state: 'observed', observedAt: '2026-10-31T11:55:00Z', windows: [{ id: 'weekly', label: 'Weekly', usedPercent: accountPct, measured: true }] },
      ],
    });
    if (url.includes('/api/verse/fleet/runs')) return Response.json({
      codexPersonal: { usedPct: 80, asOf: '2026-10-31T11:30:00Z' },
    });
    return Response.json({}, { status: 404 });
  }));
}

beforeEach(() => { evictAll(); vi.useFakeTimers({ shouldAdvanceTime: true }); vi.setSystemTime(new Date('2026-10-31T12:00:00Z')); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('places a warning beneath the fleet reading with the matching account age', async () => {
  stubReads(99);
  render(<FleetUsagePane {...props} />);
  const notice = await screen.findByText(/Two personal Codex readings disagree/);
  expect(notice).toHaveAttribute('role', 'status');
  expect(notice).toHaveAttribute('data-tone', 'warn');
  expect(notice).toHaveTextContent('fleet reads 80% (as of 30m ago, used for dispatch)');
  expect(notice).toHaveTextContent('account reader says 99% (observed 5m ago)');
  expect(notice).toHaveTextContent('leaders act on');
  expect(within(notice.closest('li[class]')?.parentElement as HTMLElement).getByRole('meter', { name: 'Codex personal personal used' })).toBeInTheDocument();
});

it('shows no warning when readings agree', async () => {
  stubReads(84);
  render(<FleetUsagePane {...props} />);
  await screen.findByRole('meter', { name: 'Codex personal personal used' });
  await screen.findByRole('meter', { name: 'Codex Personal Weekly used' });
  expect(screen.queryByText(/Two personal Codex readings disagree/)).not.toBeInTheDocument();
});
