/**
 * FleetNeedsYouRows — "Fleet on this Mac", the Needs-you drawer's LOCAL
 * producer (unit C1). The drawer derives what only Mason can fix on this
 * Mac's fleet from GET /api/verse/fleet/runs:
 *
 *   - a 404 means this build has no live runs — nothing renders and the
 *     producer still answers (All-clear logic unchanged from master);
 *   - a healthy snapshot answers with no items;
 *   - incidents render one row each — severity, title, detail, a plain
 *     next step and an Open button to the surface that can act;
 *   - the group appears only on the All and Fleet splits but REPORTS for
 *     every split, and a failed or missing read never earns an all-clear;
 *   - the read polls every 15 s while the drawer is open.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../../components/primitives/Toast.js';
import { evictAll } from '../../../data/cache.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { useVerseUi } from '../useVerseUi.js';
import { getVerseUiState, openVerseNeedsYou, resetVerseUi } from '../verse-ui-store.js';
import { GuardHost, resetGuard } from './guarded-action.js';
import { resetResolvedForTest } from './needs-you-actions.js';
import { NeedsYouDrawer } from './NeedsYouDrawer.js';
import { activity, approvalNeed, shellFetch, vetoNeed, type ShellFetch } from './shell-fixtures.test-support.js';
import { resetActivityForTest } from './useActivity.js';
import { FleetNeedsYouRows, type FleetNeedsYouReport } from './FleetNeedsYouRows.js';
import type { FleetNeedsYouItem } from './fleet-needs-you.js';
import { MockEventSource } from '../fixtures.test-support.js';
import { markCheckComplete } from '../../../data/auth-store.js';

const NOW = Date.parse('2026-10-31T12:00:00Z');

/** A healthy fleet snapshot (the ops-runs wire shape); overrides swap per test. */
function snapshot(over: Partial<FleetRuns> = {}): FleetRuns {
  return {
    v: 1,
    generatedAt: '2026-10-31T12:00:00Z',
    sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
    lastTick: '2026-10-31T11:59:00Z',
    paused: false,
    memFreePct: 50,
    diskFreeGb: 80,
    switches: [],
    claudeLane: null,
    lanes: [{ lane: 'codex-cmp', running: 1, target: 2, queued: 0, held: false, heldReason: null, tokensLastHour: 100, merged24h: 2, mergeRate24h: 50 }],
    workers: [{ job: 'job-one', repo: 'phantom', lane: 'codex-cmp', tier: 'frontier', ageSeconds: 120 }],
    leaders: [{ label: 'leader', ageSeconds: 30 }],
    orchestratorAgents: 1,
    publishesLastHour: [],
    mergesLastHour: { count: 1, items: [{ repo: 'phantom', number: 12, title: 'Fleet view' }] },
    events: [{ at: '2026-10-31T11:55:00Z', kind: 'worker-start', text: 'started job-one' }],
    codexPersonal: null,
    inbox: [],
    drop: null,
    ...over,
  };
}

/** The four-item incident snapshot from the acceptance criteria. */
const INCIDENT = snapshot({
  claudeLane: 'down token rejected 2026-10-31 01:03:35',
  lanes: [{ lane: 'codex-cmp', running: 0, target: 2, queued: 4, held: true, heldReason: 'credit exhausted', tokensLastHour: 0, merged24h: 0, mergeRate24h: 0 }],
  switches: ['HOLD'],
  diskFreeGb: 4,
});

type FleetRoute = FleetRuns | number;

let net: ShellFetch;

/**
 * shellFetch plus a controllable /api/verse/fleet/runs route. A number is a
 * status (404 = not in this build); anything else is the snapshot body.
 */
function setup(response = activity(), fleet: FleetRoute = 404) {
  net = shellFetch(response);
  const inner = net.fetch.getMockImplementation()!;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === '/api/verse/fleet/runs' && (init?.method ?? 'GET') === 'GET') {
      if (typeof fleet === 'number') return new Response('not found', { status: fleet });
      return new Response(JSON.stringify(fleet), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return inner(input, init);
  }));
  resetActivityForTest();
}

const fleetRequests = () =>
  (vi.mocked(globalThis.fetch).mock.calls as Array<[RequestInfo | URL, RequestInit | undefined]>)
    .filter(([input]) => String(input) === '/api/verse/fleet/runs').length;

function Harness() {
  const ui = useVerseUi();
  return (
    <>
      {ui.overlay === 'needs-you' ? <NeedsYouDrawer /> : null}
      <GuardHost />
    </>
  );
}

async function openDrawer(split: 'all' | 'fleet' | 'chats' = 'all') {
  render(
    <ToastProvider>
      <Harness />
    </ToastProvider>,
  );
  act(() => openVerseNeedsYou({ split }));
  return screen.findByRole('dialog', { name: /Needs you/ });
}

beforeEach(() => {
  localStorage.clear();
  evictAll();
  resetVerseUi();
  resetGuard();
  resetResolvedForTest();
  MockEventSource.reset();
  vi.stubGlobal('EventSource', MockEventSource);
  markCheckComplete(true);
});

afterEach(() => {
  act(() => markCheckComplete(false));
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetActivityForTest();
});

// ---------------------------------------------------------------------------
// The group on its own
// ---------------------------------------------------------------------------

describe('FleetNeedsYouRows', () => {
  function renderRows(split: 'all' | 'fleet' | 'chats' = 'fleet') {
    const reports: FleetNeedsYouReport[] = [];
    render(
      <FleetNeedsYouRows split={split} nowMs={NOW} onResult={(r) => reports.push(r)} />,
    );
    return reports;
  }

  it('renders nothing and still answers on 404 — the build has no live runs', async () => {
    setup(activity(), 404);
    const reports = renderRows();
    await waitFor(() => expect(reports.at(-1)).toEqual({ answered: true, items: [], silent: null }));
    expect(screen.queryByText('Fleet on this Mac')).not.toBeInTheDocument();
  });

  it('a healthy snapshot answers with nothing to show', async () => {
    setup(activity(), snapshot());
    const reports = renderRows();
    await waitFor(() => expect(reports.at(-1)).toEqual({ answered: true, items: [], silent: null }));
    expect(screen.queryByText('Fleet on this Mac')).not.toBeInTheDocument();
  });

  it('renders the incident snapshot: four rows, each with a next step and a surface', async () => {
    setup(activity(), INCIDENT);
    const reports = renderRows();
    const group = await screen.findByRole('region', { name: 'Fleet on this Mac' });
    expect(within(group).getByText('The Claude lane is down')).toBeInTheDocument();
    expect(within(group).getByText('Dispatch is paused by HOLD')).toBeInTheDocument();
    expect(within(group).getByText('Lane codex-cmp is held')).toBeInTheDocument();
    expect(within(group).getByText('This Mac is under pressure')).toBeInTheDocument();
    expect(within(group).getAllByText(/^Next: /)).toHaveLength(4);
    expect(within(group).getAllByRole('button', { name: /^Open / })).toHaveLength(4);
    expect(within(group).getAllByText('Urgent')).toHaveLength(2);
    expect(within(group).getAllByText('Attention')).toHaveLength(2);
    const last = reports.at(-1)!;
    expect(last.answered).toBe(true);
    expect(last.items.map((i: FleetNeedsYouItem) => i.id)).toEqual(
      ['claude-lane-down', 'switches-on', 'lane-held:codex-cmp', 'host-pressure'],
    );
  });

  it('Open closes the drawer and lands on the surface the item targets', async () => {
    // runs-dir-missing is the only item targeting Settings — one Open button.
    setup(activity(), snapshot({
      sources: { runsDir: 'missing', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
    }));
    const user = userEvent.setup();
    await openDrawer('fleet');
    const group = await screen.findByRole('region', { name: 'Fleet on this Mac' });
    await user.click(within(group).getByRole('button', { name: 'Open Settings' }));
    await waitFor(() => expect(getVerseUiState()).toMatchObject({ overlay: null, section: 'settings' }));
  });

  it('renders nothing on the Chats split but still reports', async () => {
    setup(activity(), INCIDENT);
    const reports = renderRows('chats');
    await waitFor(() => expect(reports.at(-1)?.items).toHaveLength(4));
    expect(screen.queryByText('Fleet on this Mac')).not.toBeInTheDocument();
  });

  it('a failed read is reported as silence — never as an all-clear', async () => {
    setup(activity(), 500);
    const reports = renderRows();
    await waitFor(() => expect(reports.at(-1)).toMatchObject({ answered: false, items: [], silent: 'error' }));
    expect(screen.queryByText('Fleet on this Mac')).not.toBeInTheDocument();
  });

  it('a missing runs dir is both an item and silence', async () => {
    setup(activity(), snapshot({
      sources: { runsDir: 'missing', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
    }));
    const reports = renderRows();
    await screen.findByText('The runs directory is missing on this Mac');
    expect(reports.at(-1)).toMatchObject({ answered: false, silent: 'unavailable' });
  });

  it('polls /api/verse/fleet/runs every 15 s while mounted, stopping at unmount', async () => {
    vi.useFakeTimers();
    setup(activity(), snapshot());
    const { unmount } = render(
      <FleetNeedsYouRows split="fleet" nowMs={NOW} onResult={() => {}} />,
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const initial = fleetRequests();
    expect(initial).toBeGreaterThanOrEqual(1);
    await act(async () => { vi.advanceTimersByTime(15_000); });
    expect(fleetRequests()).toBeGreaterThan(initial);
    const afterPoll = fleetRequests();
    unmount();
    await act(async () => { vi.advanceTimersByTime(45_000); });
    expect(fleetRequests()).toBe(afterPoll);
  });
});

// ---------------------------------------------------------------------------
// Inside the drawer: counts, coverage and the all-clear rule
// ---------------------------------------------------------------------------

describe('FleetNeedsYouRows inside NeedsYouDrawer', () => {
  it('the Fleet split shows the group above the server items and counts it', async () => {
    // A quarantine is a fleet-category item: it lives in this split.
    const quarantined = vetoNeed({
      id: 'fleet:quarantine:q-1', source: 'fleet', kind: 'quarantine',
      title: 'binshield quarantined', detail: 'Post-merge red.',
      target: { kind: 'section', section: 'fleet', anchor: null }, actions: [],
    });
    setup(activity({ needsYou: [quarantined] }), INCIDENT);
    await openDrawer('fleet');
    const group = await screen.findByRole('region', { name: 'Fleet on this Mac' });
    // Four local items plus the one server fleet item → the tab counts 5.
    expect(screen.getByRole('tab', { name: /Fleet 5 items/ })).toHaveAttribute('aria-selected', 'true');
    // The group sits above the server listbox.
    const list = await screen.findByRole('listbox', { name: /Fleet needing you/ });
    expect(group.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(group).getAllByRole('button', { name: /^Open / })).toHaveLength(4);
    expect(within(list).getAllByRole('option')).toHaveLength(1);
    // An all-clear can never be claimed while there are items.
    expect(screen.queryByText('All clear')).not.toBeInTheDocument();
  });

  it('the All split counts it too', async () => {
    setup(activity({ needsYou: [approvalNeed('p-1')] }), INCIDENT);
    await openDrawer('all');
    await screen.findByRole('region', { name: 'Fleet on this Mac' });
    expect(screen.getByRole('tab', { name: /All 5 items/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('the Chats split shows no group', async () => {
    setup(activity({ needsYou: [approvalNeed('p-1')] }), INCIDENT);
    await openDrawer('chats');
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Fleet on this Mac' })).not.toBeInTheDocument());
  });

  it('a healthy snapshot leaves the master all-clear logic untouched', async () => {
    setup(activity({ needsYou: [] }), snapshot());
    await openDrawer('fleet');
    expect(await screen.findByText('All clear')).toBeInTheDocument();
  });

  it('404 keeps the drawer exactly as before — no group, all-clear unchanged', async () => {
    setup(activity({ needsYou: [] }), 404);
    await openDrawer('fleet');
    expect(await screen.findByText('All clear')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Fleet on this Mac' })).not.toBeInTheDocument();
  });

  it('a missing runs dir blocks all-clear and names the silent producer', async () => {
    setup(activity({ needsYou: [] }), snapshot({
      sources: { runsDir: 'missing', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
    }));
    await openDrawer('fleet');
    await screen.findByRole('region', { name: 'Fleet on this Mac' });
    expect(screen.queryByText('All clear')).not.toBeInTheDocument();
    expect(await screen.findByText(/The fleet on this Mac isn't reporting in this build — this list may be incomplete/)).toBeInTheDocument();
  });

  it('a failed fleet read blocks all-clear even with zero items', async () => {
    setup(activity({ needsYou: [] }), 500);
    await openDrawer('fleet');
    expect(await screen.findByText(/it isn't an all-clear/)).toBeInTheDocument();
    expect(screen.getByText(/The fleet on this Mac failed to answer/)).toBeInTheDocument();
    expect(screen.queryByText('All clear')).not.toBeInTheDocument();
  });
});
