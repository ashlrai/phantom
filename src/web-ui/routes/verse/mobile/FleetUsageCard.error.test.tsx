import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictAll, invalidate } from '../../../data/cache.js';
import type { ResourceLedgerV1 } from '../usage/fleet-ledger-model.js';
import { fleetLedgerQuery } from '../usage/fleet-ledger-queries.js';
import { FleetUsageCard } from './FleetUsageCard.js';
import { json, renderMobile, stubFetch } from './mobile.test-support.js';

function ledger(): ResourceLedgerV1 {
  const now = Date.now();
  const lane = {
    lane: 'Codex', running: 2, target: 4, held: false, window: 'weekly' as const,
    usedPct: 72, creditsRemaining: null, resetAt: null, burnPctPerHour: 1.4,
    tokensPerHour6h: null, projectedExhaustion: new Date(now + 3_600_000).toISOString(), source: 'status',
  };
  return {
    v: 1, generatedAt: new Date(now).toISOString(), sources: { status: 'healthy', apiSpend: 'healthy' },
    asOf: new Date(now - 4 * 60_000).toISOString(),
    lanes: [lane, { ...lane, lane: 'Claude', window: 'credits', usedPct: null, creditsRemaining: 600, projectedExhaustion: null, burnPctPerHour: null }],
    apiSpend: { rowsToday: 2, errorsToday: 0, tokensOutToday: 1000, tokensInToday: 200, usdToday: 1.25, usdWeek: 2, lastAt: new Date(now).toISOString(), models: ['fake-model'] },
  };
}

afterEach(() => {
  evictAll();
  vi.unstubAllGlobals();
});

describe('FleetUsageCard read failure', () => {
  it('shows the reason and a retry that re-reads the ledger once', async () => {
    const stub = stubFetch({ 'GET /api/verse/leader/resources': () => json({ error: 'ledger store offline' }, 500) });
    renderMobile(<FleetUsageCard />);

    expect(await screen.findByText('Couldn’t read usage')).toBeInTheDocument();
    expect(screen.getByText('ledger store offline')).toBeInTheDocument();
    expect(stub.calls.map((call) => call.url)).toEqual(['/api/verse/leader/resources']);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(stub.calls).toHaveLength(2));
    expect(stub.calls.map((call) => call.url)).toEqual(['/api/verse/leader/resources', '/api/verse/leader/resources']);
    expect(await screen.findByText('Couldn’t read usage')).toBeInTheDocument();
  });

  it('keeps the last good ledger with the stale line when a refresh fails', async () => {
    let fail = false;
    const stub = stubFetch({
      'GET /api/verse/leader/resources': () => (fail ? json({ error: 'ledger store offline' }, 500) : ledger()),
    });
    renderMobile(<FleetUsageCard />);
    expect(await screen.findByText('Codex')).toBeInTheDocument();

    fail = true;
    invalidate(fleetLedgerQuery.key);

    expect(await screen.findByText(/refresh failed/)).toBeInTheDocument();
    expect(screen.getByText('Codex')).toBeInTheDocument();
    expect(screen.getByText('Claude')).toBeInTheDocument();
    expect(screen.queryByText('Couldn’t read usage')).not.toBeInTheDocument();
    expect(stub.calls).toHaveLength(2);
  });

  it('renders a successful read without the error state', async () => {
    stubFetch({ 'GET /api/verse/leader/resources': ledger() });
    renderMobile(<FleetUsageCard />);

    expect(await screen.findByText('Codex')).toBeInTheDocument();
    expect(screen.queryByText('Couldn’t read usage')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });
});
