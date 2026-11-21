/** Render test for the Pools board: bars with the projection, labelled readings, the state switch, per-model windows, server order and the unknown states. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { buildPoolsView, POOLS_PATH } from '../../../../core/fleet/pools-view.js';
import type { ResourceLaneRow, ResourceLedgerV1 } from '../../../../core/fleet/runs-resource-ledger.js';
import { evictAll } from '../../../data/cache.js';
import { listPanes, type PaneProps } from '../panes/pane-registry.js';
import { REGISTERED_DOCK_PANE_GROUPS } from '../shell/dock-pane-catalog.js';
import { FleetPoolsPane } from './FleetPoolsPane.js';
import { localTime } from './PoolItem.js';
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
const MIXED = [
  lane('claude', { usedPct: 60, resetAt: at(60), burnPctPerHour: 0.7 }),
  lane('codex-cmp', { usedPct: 10, resetAt: at(2) }, -2),
  lane('codex-personal', { usedPct: 20, resetAt: at(24), burnPctPerHour: 0.5, running: 3, target: 4 }),
];
const pools = () => screen.findAllByRole('listitem', { name: / pool$/ });
const names = () => screen.getAllByRole('listitem', { name: / pool$/ }).map(row => row.getAttribute('aria-label'));
/** The value drawn under a label in one pool's readings. */
const fact = (row: HTMLElement, label: string) => within(row).getByText(label).nextElementSibling?.textContent;
/** Each card's own bar: the meter's name and the sentence it is read as. */
const bars = (row: HTMLElement) => within(row).queryAllByRole('meter').map(bar => `${bar.getAttribute('aria-label')}: ${bar.getAttribute('aria-valuetext')}`);
/** The parts drawn inside a card's bar, left to right, with the width (or, for the time mark, the place) of each. */
const drawn = (row: HTMLElement) => [...within(row).getByRole('meter').children].map(part => [part.getAttribute('data-part'), (part as HTMLElement).style.width || (part as HTMLElement).style.left]);

const props = { visible: true } as PaneProps;
beforeEach(() => { evictAll(); vi.spyOn(Date, 'now').mockReturnValue(NOW); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('draws one card per resource, most at risk first, with its bar, projection and labelled readings', async () => {
  serve(view(...MIXED));
  render(<FleetPoolsPane {...props} />);
  const rows = await pools();
  expect(names()).toEqual(['codex-personal pool', 'claude pool', 'codex-cmp pool']);
  expect(rows.map(row => row.dataset.risk)).toEqual(['high', 'low', 'unknown']);
  expect(within(rows[0]!).getByText('Codex personal: 68% will go unused: add work')).toBeInTheDocument();
  expect(bars(rows[0]!)).toEqual(['codex-personal used: 20% used, 85.7% of the window elapsed, 32% by reset at this burn, 68% left unused']);
  // The same three parts Home draws for a pool, then the mark for the time gone.
  expect(drawn(rows[0]!)).toEqual([['used', '20%'], ['more', '12%'], ['unused', '68%'], ['elapsed', '85.7%']]);
  expect(within(rows[0]!).getByRole('meter')).toHaveAttribute('data-ending', 'unused');
  expect(within(rows[0]!).getByRole('meter')).toHaveAttribute('aria-valuenow', '20');
  expect(['Used', 'Left', 'Resets', 'Burn', 'Unused at reset', 'Empty', 'Jobs', 'Read'].map(label => fact(rows[0]!, label)))
    .toEqual(['20%', '80%', 'in 1 d', '0.5%/h', '68%', 'not before reset', '3 of 4 running', '6 min ago']);
  expect(within(rows[0]!).getByText('reported')).toBeInTheDocument();
  expect(within(rows[0]!).getByText('claude-native-usage')).toBeInTheDocument();
  expect(within(rows[1]!).getByText('Claude: on pace')).toBeInTheDocument();
  expect(bars(rows[1]!)).toEqual(['claude used: 60% used, 64.3% of the window elapsed, 100% by reset at this burn']);
  // Used up by its reset: nothing is left over, so no outline is drawn.
  expect(drawn(rows[1]!)).toEqual([['used', '60%'], ['more', '40%'], ['elapsed', '64.3%']]);
  expect(within(rows[1]!).getByRole('meter')).toHaveAttribute('data-ending', 'even');
  expect(within(rows[2]!).getByText(`Codex cmp: unknown: no reading since ${at(-2)}`)).toBeInTheDocument();
  expect(bars(rows[2]!)).toEqual(['codex-cmp used: usage unknown']);
  // No reading: hatched, no parts, no number and no time mark.
  expect(drawn(rows[2]!)).toEqual([]);
  expect(within(rows[2]!).getByRole('meter')).toHaveAttribute('data-unread');
  expect(within(rows[2]!).getByRole('meter')).not.toHaveAttribute('aria-valuenow');
  expect(document.querySelector('[data-bar-key]')).toHaveTextContent(/used so far.*more by its reset at this burn.*left unused at its reset.*time elapsed in the window/);
  // A stale reading keeps its reported reset and its age, and every usage number reads unknown.
  expect(['Used', 'Left', 'Resets', 'Burn', 'Unused at reset', 'Read'].map(label => fact(rows[2]!, label))).toEqual(['unknown', 'unknown', 'in 2 h', 'unknown', 'unknown', '2 h ago']);
  expect(screen.getByText('1 behind, 1 unknown.')).toBeInTheDocument();
  expect(screen.getByText(/^Next reset: codex-cmp in 2 h\. Read /)).toBeInTheDocument();
  expect(screen.getByText(/Not covered: API credit grants/)).toBeInTheDocument();
});

it('narrows the list by state from the switch, by click or arrow key, and says when a state is empty', async () => {
  serve(view(...MIXED));
  render(<FleetPoolsPane {...props} />);
  await pools();
  expect(screen.getAllByRole('radio').map(option => option.textContent)).toEqual(['All 3', 'Too fast 0', 'Behind 1', 'On pace 1', 'Unknown 1']);
  fireEvent.click(screen.getByRole('radio', { name: 'Behind 1' }));
  expect(names()).toEqual(['codex-personal pool']);
  fireEvent.keyDown(screen.getByRole('radio', { name: 'Behind 1' }), { key: 'ArrowRight' });
  expect(screen.getByRole('radio', { name: 'On pace 1' })).toBeChecked();
  expect(names()).toEqual(['claude pool']);
  fireEvent.keyDown(screen.getByRole('radio', { name: 'On pace 1' }), { key: 'ArrowRight' });
  expect(names()).toEqual(['codex-cmp pool']);
  cleanup(); evictAll();
  serve(view(MIXED[0]!));
  render(<FleetPoolsPane {...props} />);
  await pools();
  fireEvent.click(screen.getByRole('radio', { name: 'Behind 0' }));
  expect(screen.getByText('No pool is behind.')).toBeInTheDocument();
  expect(screen.queryAllByRole('listitem', { name: / pool$/ })).toEqual([]);
  fireEvent.click(screen.getByRole('radio', { name: 'Unknown 0' }));
  expect(screen.getByText('Every pool has a current reading.')).toBeInTheDocument();
});

it('shows per-model windows, a credit balance without a bar, a held lane and an unmetered lane', async () => {
  serve(view(
    lane('claude', { usedPct: 60, resetAt: at(60), burnPctPerHour: 0.7, quotaScopes: [{ id: 'seven_day_fable', usedPct: 41.26, resetAt: at(30) }, { id: 'seven_day_opus', usedPct: 90, resetAt: at(-1) }] }),
    lane('devin', { window: 'credits', usedPct: null, creditsRemaining: 120, resetAt: null, held: true, running: 0, target: 0 }),
    lane('codex-local', { window: 'none', usedPct: null, resetAt: null }),
  ));
  render(<FleetPoolsPane {...props} />);
  const [claude, local, devin] = await pools();
  expect(names()).toEqual(['claude pool', 'codex-local pool', 'devin pool']);
  const windows = within(claude!).getByRole('list', { name: 'claude windows by model' });
  // 30 h from a seven-day window's reset is 82% of it gone; 41.3% used is 41 points short of an even spend.
  expect(within(windows).getAllByRole('listitem').map(item => item.textContent)).toEqual([
    `Fable41.3%used82% of the window gone · use is 41 points behind an even spend · resets in 1 d 6 h (${localTime(at(30))})`,
    'Opusunknownits window reset and there is no new reading']);
  const scopeBars = within(windows).getAllByRole('meter');
  expect(scopeBars.map(bar => `${bar.getAttribute('aria-label')}: ${bar.getAttribute('aria-valuetext')}`)).toEqual([
    'claude Fable used: 41.3% used, resets in 1 d 6 h, 82% of the window gone', 'claude Opus used: usage unknown']);
  expect([...scopeBars[0]!.children].map(part => [part.getAttribute('data-part'), (part as HTMLElement).style.width || (part as HTMLElement).style.left])).toEqual([['used', '41.3%'], ['elapsed', '82.1%']]);
  // A window whose reset has passed is hatched with nothing drawn in it: never an empty bar, never a time mark.
  expect([scopeBars[1]!.hasAttribute('data-unread'), scopeBars[1]!.children.length, scopeBars[1]!.hasAttribute('aria-valuenow')]).toEqual([true, 0, false]);
  expect(within(windows).getAllByRole('listitem').map(item => item.getAttribute('data-pace'))).toEqual(['behind', null]);
  // No model is nearer its limit than the pool (60%), so nothing is called out.
  expect(claude!.querySelector('[data-scope-tightest]')).toBeNull();
  expect(bars(devin!)).toEqual([]);
  expect([fact(devin!, 'Balance'), fact(devin!, 'Jobs')]).toEqual(['120 credits', '0 of 0 running']);
  expect(within(devin!).getByText('credit balance')).toBeInTheDocument();
  expect(within(devin!).getByText('held')).toBeInTheDocument();
  expect(bars(local!)).toEqual([]);
  expect(within(local!).getByText('no usage window')).toBeInTheDocument();
  expect(fact(local!, 'Jobs')).toBe('1 of 2 running');
  expect(within(local!).queryByText('Used')).toBeNull();
  expect(screen.getByText(/^Next reset: claude in 2 d 12 h\./)).toBeInTheDocument();
});

it('names the model nearest its limit when it is nearer than the pool, and marks time only on a window of stated length', async () => {
  serve(view(lane('claude', { usedPct: 60, resetAt: at(60), burnPctPerHour: 0.7, quotaScopes: [
    { id: 'seven_day_opus', usedPct: 90, resetAt: at(84) }, { id: 'seven_day_sonnet', usedPct: 50, resetAt: at(84) },
    { id: 'five_hour_haiku', usedPct: 12, resetAt: at(2) }, { id: 'seven_day_fable', usedPct: 70, resetAt: null }] })));
  render(<FleetPoolsPane {...props} />);
  const [claude] = await pools();
  expect(claude!.querySelector('[data-scope-tightest]')?.textContent).toBe('Opus is nearest its limit: 90% used, against 60% for the pool.');
  const windows = within(claude!).getByRole('list', { name: 'claude windows by model' });
  const rows = within(windows).getAllByRole('listitem');
  expect(rows.map(item => item.getAttribute('data-pace'))).toEqual(['ahead', 'level', null, null]);
  expect(rows.map(item => item.lastElementChild?.textContent)).toEqual([
    `50% of the window gone · use is 40 points ahead of an even spend · resets in 3 d 12 h (${localTime(at(84))})`,
    `50% of the window gone · use is level with an even spend · resets in 3 d 12 h (${localTime(at(84))})`,
    `resets in 2 h (${localTime(at(2))})`, 'reset unknown']);
  // The id does not say how long a five-hour window is, and a window with no reset has no start: neither gets a time mark.
  expect(within(windows).getAllByRole('meter').map(bar => [...bar.children].map(part => part.getAttribute('data-part')))).toEqual([['used', 'elapsed'], ['used', 'elapsed'], ['used'], ['used']]);
  // The card's own bar is still the first meter on the card and still reads the pool, not a model.
  expect(bars(claude!)[0]).toMatch(/^claude used: 60% used/);
});

it('says so when every reading is unknown, and never draws a zero bar or a zero reading', async () => {
  serve(view(lane('claude', { usedPct: null, resetAt: null, running: null }), lane('devin', { window: 'credits', usedPct: null, creditsRemaining: null, resetAt: null })));
  render(<FleetPoolsPane {...props} />);
  const [claude, devin] = await pools();
  expect(screen.getByText('No current reading for any resource. Nothing here is known to be on pace.')).toBeInTheDocument();
  expect(bars(claude!)).toEqual(['claude used: usage unknown']);
  expect(['Used', 'Left', 'Resets', 'Burn', 'Unused at reset', 'Jobs'].map(label => fact(claude!, label))).toEqual(Array(6).fill('unknown'));
  expect(fact(devin!, 'Balance')).toBe('unknown');
  expect(screen.getByText('Claude: unknown: no reading')).toBeInTheDocument();
  expect(screen.getByText(/^Next reset unknown\./)).toBeInTheDocument();
  expect(screen.queryByText(/^0(\.0)?%/)).toBeNull();
  expect(screen.queryByText(/on pace$/)).toBeNull();
});

it('reads rows from an older server without the newer fields as unknown jobs and no per-model windows', async () => {
  const built = view(MIXED[0]!);
  serve({ ...built, pools: built.pools.map(({ running: _running, target: _target, source: _source, scopes: _scopes, ...row }) => row) });
  render(<FleetPoolsPane {...props} />);
  const [claude] = await pools();
  expect(fact(claude!, 'Jobs')).toBe('unknown');
  expect(fact(claude!, 'Used')).toBe('60%');
  expect(within(claude!).queryByRole('list')).toBeNull();
});

it('handles an empty list, a failed read and a drifted payload without inventing rows', async () => {
  serve(view());
  const first = render(<FleetPoolsPane {...props} />);
  expect(await screen.findByText('No resources reported.')).toBeInTheDocument();
  expect(screen.queryByRole('radiogroup')).toBeNull();
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
