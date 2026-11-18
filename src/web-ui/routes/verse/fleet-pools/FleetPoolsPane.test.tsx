/** Render test for the Pools pane: bars, plain-words lines, server order and the all-unknown state. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { buildPoolsView, POOLS_PATH } from '../../../../core/fleet/pools-view.js';
import type { ResourceLaneRow, ResourceLedgerV1 } from '../../../../core/fleet/runs-resource-ledger.js';
import { evictAll } from '../../../data/cache.js';
import { listPanes, type PaneProps } from '../panes/pane-registry.js';
import { REGISTERED_DOCK_PANE_GROUPS } from '../shell/dock-pane-catalog.js';
import { FleetPoolsPane } from './FleetPoolsPane.js';
import './fleet-pools.pane.js';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const at = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
const lane = (name: string, patch: Partial<ResourceLaneRow>, asOfHours = -0.1): ResourceLaneRow => ({
  lane: name, running: 1, target: 2, held: false, window: 'weekly', usedPct: 50, creditsRemaining: null, resetAt: at(84),
  burnPctPerHour: null, tokensPerHour6h: null, projectedExhaustion: null, source: null, deadSignal: null,
  observation: { source: 'claude-native-usage', asOf: at(asOfHours) }, ...patch,
});
// The pane renders exactly what the server builds, so the fixture goes through the real builder.
const view = (...lanes: ResourceLaneRow[]) => buildPoolsView({ v: 1, generatedAt: at(0), asOf: at(0), lanes, apiSpend: null, jobsMalformedRows: null,
  sources: { status: 'healthy', apiSpend: 'missing', jobs: 'missing' } } satisfies ResourceLedgerV1, NOW);
const serve = (body: unknown, status = 200) => vi.stubGlobal('fetch', vi.fn(async (url: string) =>
  url.includes(POOLS_PATH) ? Response.json(body, { status }) : Response.json({}, { status: 404 })));

const props = { visible: true } as PaneProps;
beforeEach(() => { evictAll(); vi.spyOn(Date, 'now').mockReturnValue(NOW); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('draws one bar per resource with a plain-words line, most at risk first', async () => {
  serve(view(
    lane('claude', { usedPct: 60, resetAt: at(60), burnPctPerHour: 0.7 }),
    lane('codex-cmp', { usedPct: 10, resetAt: at(2) }, -2),
    lane('codex-personal', { usedPct: 20, resetAt: at(24), burnPctPerHour: 0.5 }),
  ));
  render(<FleetPoolsPane {...props} />);
  const rows = await screen.findAllByRole('listitem');
  expect(rows.map(row => row.getAttribute('aria-label'))).toEqual(['codex-personal pool', 'claude pool', 'codex-cmp pool']);
  expect(rows.map(row => row.dataset.risk)).toEqual(['high', 'low', 'unknown']);
  expect(within(rows[0]!).getByText('behind: 68% would go unused')).toBeInTheDocument();
  expect(within(rows[0]!).getByRole('img', { name: 'codex-personal: 20% used, 85.7% of the window elapsed' })).toBeInTheDocument();
  expect(within(rows[1]!).getByText('on pace')).toBeInTheDocument();
  expect(within(rows[2]!).getByText(`unknown: no reading since ${at(-2)}`)).toBeInTheDocument();
  expect(within(rows[2]!).getByRole('img', { name: 'codex-cmp usage unknown' })).toBeInTheDocument();
  expect(within(rows[2]!).getByText(/Used unknown/)).toBeInTheDocument();
  expect(screen.getByText('1 behind, 1 unknown.')).toBeInTheDocument();
  expect(screen.getByText(/Not covered: API credit grants/)).toBeInTheDocument();
});

it('says so when every reading is unknown, and never draws a zero bar', async () => {
  serve(view(lane('claude', { usedPct: null }), lane('devin', { window: 'credits', usedPct: null, creditsRemaining: 40, resetAt: null })));
  render(<FleetPoolsPane {...props} />);
  expect(await screen.findByText('No current reading for any resource. Nothing here is known to be on pace.')).toBeInTheDocument();
  expect(screen.getAllByRole('img').map(bar => bar.getAttribute('aria-label'))).toEqual(['claude usage unknown', 'devin usage unknown']);
  expect(screen.getByText('unknown: no reading')).toBeInTheDocument();
  expect(screen.queryByText(/0% used/)).toBeNull();
  expect(screen.queryByText(/on pace$/)).toBeNull();
});

it('handles an empty list, a failed read and a drifted payload without inventing rows', async () => {
  serve(view());
  const first = render(<FleetPoolsPane {...props} />);
  expect(await screen.findByText('No resources reported.')).toBeInTheDocument();
  first.unmount(); evictAll();
  serve({ error: 'down' }, 500);
  const second = render(<FleetPoolsPane {...props} />);
  expect(await screen.findByText('Pools are unavailable.')).toBeInTheDocument();
  second.unmount(); evictAll();
  serve({ schema: 'pools.v2', pools: [] });
  render(<FleetPoolsPane {...props} />);
  expect(await screen.findByText('Pools are unavailable.')).toBeInTheDocument();
});

it('registers as a fleet pane', () => {
  expect(listPanes().find(pane => pane.id === 'fleet-pools')).toMatchObject({ title: 'Pools', needsSession: false });
  expect(REGISTERED_DOCK_PANE_GROUPS['fleet-pools']).toBe('fleet');
});

it('shows recorded reading age and the eight-hour stale flag from the typed API', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes(POOLS_PATH) ? view() : {
    readings: [{ pool: 'ultra', reading: { pct: 25, ts: NOW / 1000 - 28800, reset_at: NOW / 1000 + 86400, src: 'Provider usage page' }, ageSeconds: 28800, stale: true }],
  })));
  render(<FleetPoolsPane {...props} />);
  expect(await screen.findByText('ultra: 25% used · age 28800s · Provider usage page · stale (stale after 8h)')).toBeInTheDocument();
});
