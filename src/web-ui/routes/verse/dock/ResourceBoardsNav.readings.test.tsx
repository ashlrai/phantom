/**
 * dock/ResourceBoardsNav.readings.test.tsx — the live reading beside the Pools,
 * Usage and Lanes names: counted from the boards' own reads, absent while a read has
 * not answered or has failed, and never asked for while the row is hidden.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPoolsView, POOLS_PATH } from '../../../../core/fleet/pools-view.js';
import type { ResourceLaneRow, ResourceLedgerV1 } from '../../../../core/fleet/runs-resource-ledger.js';
import { evictAll } from '../../../data/cache.js';
import { rowsFromAccounts } from '../fleet-usage/usage-pane-model.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { registerPane, resetPaneRegistry } from '../panes/pane-registry.js';
import { ResourceBoardsNav } from './ResourceBoardsNav.js';
import { projectAccountsSnapshot } from '../usage/usage-contract.js';
import { lanesReading, poolsReading, usageReading } from './resource-board-readings.js';
import { TasksGlyph } from './dock-icons.js';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const at = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
const pool = (name: string, patch: Partial<ResourceLaneRow>, asOfHours = -0.1): ResourceLaneRow => ({
  lane: name, running: 1, target: 2, held: false, window: 'weekly', usedPct: 50, creditsRemaining: null, resetAt: at(84),
  burnPctPerHour: null, tokensPerHour6h: null, projectedExhaustion: null, source: null, deadSignal: null,
  observation: { source: 'claude-native-usage', asOf: at(asOfHours) }, ...patch,
});
// The same builder the server runs, so "behind" and "unknown" are its verdicts, not the fixture's.
const poolsView = (...lanes: ResourceLaneRow[]) => buildPoolsView({ v: 1, generatedAt: at(0), asOf: at(0), lanes, apiSpend: null, jobsMalformedRows: null,
  sources: { status: 'healthy', apiSpend: 'missing', jobs: 'missing' } } satisfies ResourceLedgerV1, NOW);
const ON_PACE = pool('claude', { usedPct: 60, resetAt: at(60), burnPctPerHour: 0.7 });
const BEHIND = pool('codex-personal', { usedPct: 20, resetAt: at(24), burnPctPerHour: 0.5 });
const UNREAD = pool('codex-cmp', { usedPct: 10, resetAt: at(2) }, -2);
const FAST = pool('grok', { usedPct: 70, resetAt: at(40), burnPctPerHour: 3.5 });

// GET /api/verse/accounts bodies, narrowed by the same contract the Usage board uses.
const account = (id: string, patch: Record<string, unknown> = {}) => ({
  id, label: id, provider: 'codex', state: 'observed', authentication: 'signed-in',
  windows: [{ id: 'weekly', label: 'Weekly', usedPercent: 40, resetsAt: at(30), limitReached: false, measured: true }], ...patch,
});
const FLAGGED = account('codex-team', { windows: [{ id: 'weekly', label: 'Weekly', usedPercent: 100, resetsAt: at(30), limitReached: true, measured: false }] });
const FULL_NOT_FLAGGED = account('codex-credits', { windows: [{ id: 'weekly', label: 'Weekly', usedPercent: 100, resetsAt: at(30), limitReached: false, measured: true }] });
const SIGNED_OUT = account('grok', { provider: 'grok', state: 'signed-out', authentication: 'signed-out', windows: [] });
const accountsBody = (...accounts: unknown[]) => ({ sampledAt: at(-0.01), refreshing: false, accounts });
const usageRows = (...accounts: unknown[]) => rowsFromAccounts(projectAccountsSnapshot(accountsBody(...accounts)));

const lane = (name: string, running: number, target: number, held = false): FleetRuns['lanes'][number] =>
  ({ lane: name, running, target, queued: 0, held, heldReason: held ? 'quota' : null, tokensLastHour: null, merged24h: null, mergeRate24h: null });
const runs = (...lanes: FleetRuns['lanes']): FleetRuns => ({
  v: 1, generatedAt: at(0), sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: at(0), paused: false, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null, lanes,
  workers: [], leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: null, items: [] }, events: [],
  codexPersonal: null, inbox: [], drop: null,
});

let disposers: Array<() => void> = [];
function serve(routes: { pools?: unknown; runs?: unknown; accounts?: unknown }) {
  const fetchMock = vi.fn(async (url: string) =>
    url.includes(POOLS_PATH) && routes.pools !== undefined ? Response.json(routes.pools)
      : url.includes('/api/verse/accounts') && routes.accounts !== undefined ? Response.json(routes.accounts)
      : url.includes('/api/verse/fleet/runs') && routes.runs !== undefined ? Response.json(routes.runs)
        : Response.json({ error: 'down' }, { status: 500 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const button = (name: string | RegExp) => within(screen.getByRole('navigation', { name: 'Resource boards' })).getByRole('button', { name });

beforeEach(() => {
  evictAll();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  resetPaneRegistry();
  disposers = (['fleet-pools:Pools', 'fleet-usage:Usage', 'fleet-lanes:Lanes'] as const).map((entry) => {
    const [id, title] = entry.split(':') as [string, string];
    return registerPane({ id, title, icon: TasksGlyph, component: () => null, needsSession: false });
  });
});
afterEach(() => {
  cleanup();
  for (const dispose of disposers) dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('resource board readings', () => {
  it('counts pools behind before pools unknown, and says nothing while every pool is on pace', () => {
    expect(poolsReading(poolsView(ON_PACE, BEHIND, UNREAD))).toEqual({ text: '1 behind', tone: 'attention', detail: '1 behind, 1 unknown.' });
    expect(poolsReading(poolsView(ON_PACE, UNREAD))).toEqual({ text: '1 unknown', tone: 'quiet', detail: 'Nothing is behind, 1 unknown.' });
    expect(poolsReading(poolsView(ON_PACE))).toBeNull();
    expect(poolsReading(poolsView())).toBeNull();
  });

  it('puts a pool that runs empty before its reset ahead of pools behind', () => {
    expect(poolsReading(poolsView(ON_PACE, BEHIND, FAST))).toEqual({ text: '1 too fast', tone: 'attention', detail: '1 too fast, 1 behind.' });
  });

  it('counts accounts a provider flags at a limit, else accounts it could not read', () => {
    expect(usageReading(usageRows(account('claude'), FLAGGED, SIGNED_OUT)))
      .toEqual({ text: '1 at limit', tone: 'attention', detail: '3 accounts: 1 flagged at a limit, 1 not readable.' });
    expect(usageReading(usageRows(account('claude'), SIGNED_OUT))).toEqual({ text: '1 unread', tone: 'quiet', detail: '2 accounts: 1 not readable.' });
    // 100% used without the provider's flag is not "at a limit": credits can keep such an account usable.
    expect(usageReading(usageRows(account('claude'), FULL_NOT_FLAGGED))).toBeNull();
    expect(usageReading(usageRows())).toBeNull();
  });

  it('draws the Usage reading from the accounts read, and none when that body is not the accounts snapshot', async () => {
    serve({ accounts: accountsBody(account('claude'), FLAGGED, SIGNED_OUT) });
    const first = render(<ResourceBoardsNav current="fleet-pools" visible primary />);
    const usage = await waitFor(() => button('Usage 1 at limit'));
    expect(within(usage).getByText('1 at limit')).toHaveAttribute('data-tone', 'attention');
    expect(usage.title).toMatch(/^3 accounts: 1 flagged at a limit, 1 not readable\. What the fleet has/);
    first.unmount();
    evictAll();
    const fetchMock = serve({ accounts: { ok: true } });
    render(<ResourceBoardsNav current="fleet-pools" visible primary />);
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/verse/accounts'))).toBe(true));
    await Promise.resolve();
    expect(button(/^Usage/)).toHaveTextContent(/^Usage$/);
  });

  it('counts held lanes, else slots running against slots asked for', () => {
    expect(lanesReading(runs(lane('claude', 3, 4), lane('codex', 2, 2, true)))).toEqual({ text: '1 held', tone: 'attention', detail: '5 of 6 slots running, 1 lane held.' });
    expect(lanesReading(runs(lane('claude', 3, 4), lane('codex', 2, 2)))).toEqual({ text: '5/6', tone: 'quiet', detail: '5 of 6 slots running.' });
    expect(lanesReading(runs())).toBeNull();
  });

  it('draws each reading beside its name, from the reads the boards use', async () => {
    serve({ pools: poolsView(ON_PACE, BEHIND, UNREAD), runs: runs(lane('claude', 3, 4), lane('codex', 2, 2)) });
    render(<ResourceBoardsNav current="fleet-usage" visible primary />);
    const pools = await waitFor(() => button('Pools 1 behind'));
    expect(within(pools).getByText('1 behind')).toHaveAttribute('data-tone', 'attention');
    expect(pools.title).toMatch(/^1 behind, 1 unknown\. What the fleet has/);
    expect(within(button('Lanes 5/6')).getByText('5/6')).toHaveAttribute('data-tone', 'quiet');
    // A board with no reading of its own keeps its plain name.
    expect(button('Usage')).toHaveTextContent(/^Usage$/);
  });

  it('shows no reading for a read that failed, and keeps the other', async () => {
    serve({ runs: runs(lane('claude', 0, 4, true)) });
    render(<ResourceBoardsNav current="fleet-usage" visible primary />);
    await waitFor(() => button('Lanes 1 held'));
    expect(button(/^Pools/)).toHaveTextContent(/^Pools$/);
  });

  it('shows no reading when the shared cache entry holds something that is not the runs snapshot', async () => {
    // Other readers write under the same cache key; a payload this row cannot vouch for is not counted.
    serve({ pools: poolsView(BEHIND), runs: { v: 1, generatedAt: at(0) } });
    render(<ResourceBoardsNav current="fleet-usage" visible primary />);
    await waitFor(() => button('Pools 1 behind'));
    expect(button(/^Lanes/)).toHaveTextContent(/^Lanes$/);
  });

  it('asks for nothing while the board is behind another tab', async () => {
    const fetchMock = serve({ pools: poolsView(BEHIND), runs: runs(lane('claude', 1, 1)) });
    render(<ResourceBoardsNav current="fleet-usage" visible={false} primary={false} />);
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(button(/^Pools/)).toHaveTextContent(/^Pools$/);
  });
});
