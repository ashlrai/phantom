import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { FleetView } from './FleetView.js';
import { evictAll } from '../../../data/cache.js';

const FLEET = {
  generatedAt: new Date().toISOString(),
  daemon: { running: true, lastTickAt: null, todaySpentUsd: 0 },
  backends: [],
  queue: {
    backlogItems: 5,
    eligibleBacklogItems: 3,
    shared: {
      path: '/tmp/queue',
      leaseMs: 60000,
      readable: true,
      capability: { scope: 'local-primitives-only', durabilityPolicy: 'posix-file-and-directory-fsync', checked: true, verified: true, failure: null },
      activeClaims: 2,
      ownedClaims: 1,
      expiredClaims: 0,
      reclaimableClaims: 0,
      claimsByMachine: [{ machineId: 'm1', active: 2, expired: 0 }],
      claimSamples: [],
      nextLeaseExpiryAt: null,
      oldestExpiredMs: null,
      workedEvents: 0,
      cooldownItems: 0,
      usageEntries: 0,
      lock: { present: true, ageMs: 10, stale: false },
    },
  },
  proposals: { pending: 0, frontierPending: 0, applied: 0 },
  merges: { recent: 2 },
  autonomyControlMode: 'enabled',
  killed: false,
  killSwitch: { state: 'inactive', sourceState: 'healthy', reason: 'present' },
};

const ACTIVITY = {
  ts: new Date().toISOString(),
  repos: [],
  totalProposed: 0,
  totalAutoMerged: 0,
  totalPending: 0,
  totalDeclined: 0,
  recentMerges: [],
  recentActions: [],
  engineReadiness: [],
  subscriptionUsage: [],
  cooldownCount: 0,
  recentTicks: [],
  recentTicksFreshness: { stale: false, ageMs: 0 },
};

function respondFor(fleetBody: unknown) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/fleet-activity')) return new Response(JSON.stringify(ACTIVITY), { status: 200 });
    if (url.startsWith('/api/fleet')) return new Response(JSON.stringify(fleetBody), { status: 200 });
    return new Response('not found', { status: 404 });
  });
}

describe('FleetView', () => {
  beforeEach(() => {
    evictAll();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders queue depth and lease health from GET /api/fleet', async () => {
    vi.stubGlobal('fetch', respondFor(FLEET));
    render(
      <MemoryRouter>
        <FleetView />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('5')).toBeInTheDocument());
    expect(screen.getByText('clear — fleet active')).toBeInTheDocument();
    expect(screen.getByText('m1')).toBeInTheDocument();
  });

  it('explains existing queue holds without offering or sending mutations', async () => {
    const fetch = respondFor({ ...FLEET, queue: { ...FLEET.queue,
      cooldownItems: 2, pendingItems: 1, repairRouteBlockedItems: 3,
      repairControlBlockedItems: 4, repairLifecycleUnavailableItems: 5,
      repairTerminalItems: 0, repairQuarantinedItems: 6,
    } });
    vi.stubGlobal('fetch', fetch);
    render(<MemoryRouter><FleetView /></MemoryRouter>);

    const holds = within(await screen.findByRole('region', { name: 'Queue holds' }));
    for (const count of [0, 1, 2, 3, 4, 5, 6]) {
      expect(holds.getByText(`${count} held`)).toBeInTheDocument();
    }
    expect(holds.getByText('Waiting for the retry cooldown to expire.')).toBeInTheDocument();
    expect(holds.queryByRole('button')).not.toBeInTheDocument();
    fireEvent.click(holds.getByText('6 held'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fetch.mock.calls.length).toBeGreaterThan(0);
    expect(fetch.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  });

  it('shows unknown holds when optional queue observations are absent', async () => {
    const fetch = respondFor(FLEET);
    vi.stubGlobal('fetch', fetch);
    render(<MemoryRouter><FleetView /></MemoryRouter>);

    const holds = within(await screen.findByRole('region', { name: 'Queue holds' }));
    expect(holds.getAllByText('Unknown')).toHaveLength(7);
    expect(holds.queryByText('0 held')).not.toBeInTheDocument();
    fireEvent.click(holds.getAllByText('Unknown')[0]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fetch.mock.calls.length).toBeGreaterThan(0);
    expect(fetch.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  });

  it('requires an explicit confirm dialog before the kill switch mutation can fire', async () => {
    vi.stubGlobal('fetch', respondFor(FLEET));
    render(
      <MemoryRouter>
        <FleetView />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Pause fleet')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Pause fleet'));

    // Confirm dialog appears; the mutation must NOT have fired yet (no POST).
    expect(await screen.findByText('Pause the fleet?')).toBeInTheDocument();
    const postCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => (call[1] as RequestInit | undefined)?.method === 'POST',
    );
    expect(postCalls.length).toBe(0);
  });

  it('withholds the kill switch control when killSwitch source is degraded', async () => {
    const degraded = { ...FLEET, killSwitch: { state: 'unknown', sourceState: 'degraded', reason: 'uninspectable' } };
    vi.stubGlobal('fetch', respondFor(degraded));
    render(
      <MemoryRouter>
        <FleetView />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('unknown')).toBeInTheDocument());
    expect(screen.queryByText('Pause fleet')).not.toBeInTheDocument();
    expect(screen.queryByText('Resume fleet')).not.toBeInTheDocument();
  });
});
