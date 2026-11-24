/** Render test for the Runway line on the Pools board: rows, words, the marks that carry state, and the jump to a pool's card. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { buildPoolsView, POOLS_PATH } from '../../../../core/fleet/pools-view.js';
import type { ResourceLaneRow, ResourceLedgerV1 } from '../../../../core/fleet/runs-resource-ledger.js';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetPoolsPane } from './FleetPoolsPane.js';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const at = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
const lane = (name: string, patch: Partial<ResourceLaneRow>, asOfHours = -0.1): ResourceLaneRow => ({
  lane: name, running: 1, target: 2, held: false, window: 'weekly', usedPct: 50, creditsRemaining: null, resetAt: at(84),
  burnPctPerHour: null, tokensPerHour6h: null, projectedExhaustion: null, source: null, deadSignal: null,
  observation: { source: 'claude-native-usage', asOf: at(asOfHours) }, ...patch,
});
const view = (...lanes: ResourceLaneRow[]) => buildPoolsView({ v: 1, generatedAt: at(0), asOf: at(0), lanes, apiSpend: null, jobsMalformedRows: null,
  sources: { status: 'healthy', apiSpend: 'missing', jobs: 'missing' } } satisfies ResourceLedgerV1, NOW);
const serve = (body: unknown) => vi.stubGlobal('fetch', vi.fn(async (url: string) =>
  url.includes(POOLS_PATH) ? Response.json(body) : Response.json({}, { status: 404 })));
const FLEET = [
  lane('claude', { usedPct: 80, resetAt: at(60), burnPctPerHour: 2, quotaScopes: [{ id: 'seven_day_fable', usedPct: 41.26, resetAt: at(30) }] }),
  lane('codex-cmp', { usedPct: 10, resetAt: at(2) }, -2),
  lane('codex-personal', { usedPct: 20, resetAt: at(24), burnPctPerHour: 0.5 }),
  lane('devin', { window: 'credits', usedPct: null, creditsRemaining: 120, resetAt: null }),
];
const line = () => screen.findByRole('list', { name: 'Runway ahead, soonest reset first' });
const card = (name: string) => screen.getByRole('listitem', { name: `${name} pool` });

const props = { visible: true } as PaneProps;
beforeEach(() => { evictAll(); vi.spyOn(Date, 'now').mockReturnValue(NOW); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('draws every plan pool on one line, soonest reset first, with the dry stretch only where the pool runs out first', async () => {
  serve(view(...FLEET));
  render(<FleetPoolsPane {...props} />);
  const rows = within(await line()).getAllByRole('listitem');
  expect(rows.map(row => [row.dataset.state, row.dataset.flagged, row.dataset.scope])).toEqual([
    ['unknown', undefined, undefined], ['lasts', undefined, undefined], ['dry', 'true', undefined], ['window', undefined, 'true'],
  ]);
  expect(rows.map(row => row.lastElementChild?.textContent)).toEqual([
    'usage unknown', 'lasts to reset, 68% unused at this burn', 'empty in 10 h, then dry 2 d 2 h until reset', '41.3% used',
  ]);
  expect(rows.map(row => row.querySelector('time')?.getAttribute('datetime'))).toEqual([at(2), at(24), at(60), at(30)]);
  expect(within(rows[2]!).getByText(/^in 2 d 12 h · /)).toBeInTheDocument();
  // Only the pool that runs out first carries a dry stretch, from where it empties to its reset.
  expect(rows.map(row => row.querySelector<HTMLElement>('[data-dry]')?.style.cssText ?? null)).toEqual([null, null, 'left: 16.7%; width: 83.3%;', null]);
  expect(within(card('claude')).getByText(/Over pace, empty in about 10 h/)).toHaveAttribute('data-over', 'true');
  const region = screen.getByRole('region', { name: 'Runway ahead' });
  expect(within(region).getByText('1 of 3 plan pools runs empty before reset. 1 cannot be projected: no usage or burn reading.')).toBeInTheDocument();
  expect(within(region).getByText('Not on the line: devin (credit balance, no window).')).toBeInTheDocument();
  // A per-model window is a line of text; only a pool's name is a button.
  expect(within(region).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(
    ['codex-cmp: show its card', 'codex-personal: show its card', 'claude: show its card']);
});

it('puts the keyboard on the chosen pool\'s card, showing it again when the state switch had hidden it', async () => {
  serve(view(...FLEET));
  render(<FleetPoolsPane {...props} />);
  await line();
  fireEvent.click(screen.getByRole('button', { name: 'codex-personal: show its card' }));
  await waitFor(() => expect(card('codex-personal')).toHaveFocus());
  // Narrowed to the pool running out early: codex-personal's card is gone until its name is chosen on the line.
  fireEvent.click(screen.getByRole('radio', { name: 'Too fast 1' }));
  expect(screen.queryByRole('listitem', { name: 'codex-personal pool' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'claude: show its card' }));
  await waitFor(() => expect(card('claude')).toHaveFocus());
  expect(screen.getByRole('radio', { name: 'Too fast 1' })).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: 'codex-personal: show its card' }));
  await waitFor(() => expect(card('codex-personal')).toHaveFocus());
  expect(screen.getByRole('radio', { name: 'All 4' })).toBeChecked();
});

it('draws no line when no pool has a reset ahead, and never a zero', async () => {
  serve(view(lane('claude', { usedPct: null, resetAt: null }), lane('devin', { window: 'credits', usedPct: null, creditsRemaining: null, resetAt: null })));
  render(<FleetPoolsPane {...props} />);
  expect(await screen.findByText(/^Next reset unknown\./)).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Runway ahead' })).toBeNull();
  expect(screen.queryByText(/^0(\.0)?%/)).toBeNull();
});
