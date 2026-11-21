/** Router pane: the route table, the try order with usage and resets, held-back seats, the decision log and every unknown state. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ShadowDecisionRecord } from '../../../../core/routing/budget-store.js';
import type { BudgetView } from '../../../../core/routing/policy.js';
import type { SeatDecision, SeatHeadroom } from '../../../../core/routing/types.js';
import { evictAll } from '../../../data/cache.js';
import { listPanes, type PaneProps } from '../panes/pane-registry.js';
import { REGISTERED_DOCK_PANE_GROUPS } from '../shell/dock-pane-catalog.js';
import { FleetRouterPane } from './FleetRouterPane.js';
import { ROUTER_DECISIONS_PATH, ROUTER_DIFFICULTIES, ROUTER_TASKS, routeAt, routeSeats, routerPreviewPath, summarizeDecisions, tableShares, type BudgetRoute } from './router-model.js';
import './fleet-router.pane.js';

const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const at = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
const headroom = (seatId: string, patch: Partial<SeatHeadroom>): SeatHeadroom => ({ seatId, sessionUsedPercent: null, weeklyUsedPercent: null,
  bindingWindow: null, autonomyHeadroomPercent: null, resetAt: null, eligibleForAutonomy: true, reasons: [], ...patch });
const VIEW = {
  sampledAt: at(-0.05),
  seatInfo: [{ seatId: 'claude', label: 'Claude Max', engine: 'claude', free: false }, { seatId: 'codex-cmp', label: 'Codex', engine: 'codex', free: false },
    { seatId: 'local:qwen3:8b', label: 'qwen3:8b', engine: 'local', free: true }, { seatId: 'grok', label: 'Grok', engine: 'grok', free: false }],
  headroom: [headroom('claude', { weeklyUsedPercent: 23, bindingWindow: 'weekly', resetAt: at(44) }), headroom('codex-cmp', { sessionUsedPercent: 96, weeklyUsedPercent: 40, bindingWindow: 'session', resetAt: at(2) }),
    headroom('local:qwen3:8b', {}), headroom('grok', {})],
} as unknown as BudgetView;
const decision = (patch: Partial<SeatDecision> = {}): SeatDecision => ({ seatId: 'claude', candidates: ['claude', 'codex-cmp', 'local:qwen3:8b'], mode: 'balanced',
  why: 'Claude Max has the most headroom.', summary: 'Claude Max has the most headroom',
  exclusions: [{ seatId: 'grok', reasons: ['Signed out.'], nextEligibleAt: null, details: [{ kind: 'signed-out', text: 'Signed out.' }] }], ...patch });
const record = (hours: number, seatId: string | null, actual: ShadowDecisionRecord['actual'] = null): ShadowDecisionRecord => ({ v: 1, at: at(hours), source: 'daemon',
  request: { task: 'code', difficulty: 'medium', autonomous: true }, decision: decision({ seatId }), actual });

/** Every task at every difficulty, each cell from `cell` (the default decision when it returns nothing). */
const routesOf = (cell: (task: string, difficulty: string) => SeatDecision | undefined = () => undefined): BudgetRoute[] =>
  ROUTER_TASKS.flatMap(task => ROUTER_DIFFICULTIES.map(difficulty => ({ task: task.value, difficulty: difficulty.value, decision: cell(task.value, difficulty.value) ?? decision() })));
const NO_SEAT = decision({ seatId: null, candidates: [], summary: 'No seat has headroom for high difficulty work' });
/** A preview the server fails to answer. */
const DOWN = Symbol('down');
/** What the preview route answers for one kind of work: a body, DOWN, or nothing for the default decision. */
type Cell = (task: string, difficulty: string, autonomous: boolean) => unknown;
type Routes = { cell?: Cell; budget?: unknown; decisions?: unknown; fail?: string[] };
const previews = (fetch: { mock: { calls: unknown[][] } }): string[] => fetch.mock.calls.map(([url]) => String(url)).filter(url => url.includes('/budget/preview'));
const serve = (routes: Routes) => {
  const fetch = vi.fn(async (input: string) => {
    const url = String(input);
    if (routes.fail?.some(part => url.includes(part))) return Response.json({ error: 'down' }, { status: 500 });
    if (url.includes('/budget/preview')) {
      const query = new URL(url, 'http://localhost').searchParams;
      const body = routes.cell?.(query.get('task') ?? '', query.get('difficulty') ?? '', query.get('autonomous') === 'true');
      return body === DOWN ? Response.json({ error: 'down' }, { status: 500 }) : Response.json(body ?? decision());
    }
    if (url.includes('/budget/decisions')) return Response.json(routes.decisions ?? { decisions: [] });
    if (url.includes('/api/verse/budget')) return Response.json(routes.budget ?? VIEW);
    return Response.json({}, { status: 404 });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
};
const props = { visible: true } as PaneProps;
beforeEach(() => { evictAll(); vi.spyOn(Date, 'now').mockReturnValue(NOW); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('FleetRouterPane', () => {
  it('draws the try order with each seat\'s mark, usage and reset, then the seats held back', async () => {
    const fetch = serve({});
    const { container } = render(<FleetRouterPane {...props} />);
    expect(await screen.findByText('Goes to Claude Max')).toBeInTheDocument();
    expect(screen.getByText('balanced')).toBeInTheDocument();
    const order = within(screen.getByRole('list', { name: 'Try order' })).getAllByRole('listitem');
    expect(order.map(row => row.textContent?.replace(/^\d/, '').split(/Usage|\d+%|Local/)[0])).toEqual(['Claude Max', 'Codex', 'qwen3:8b']);
    expect(within(order[0]!).getByRole('img', { name: 'Claude Max: 23% of the weekly window used' })).toBeInTheDocument();
    expect(order[0]!.textContent).toMatch(/23% of the weekly window used · resets /);
    // Each seat carries its provider's mark; a local seat is looked up by engine, not by its model tag.
    expect(order.map(row => row.querySelector('svg[data-provider]')?.getAttribute('data-provider'))).toEqual(['claude', 'codex', 'local']);
    // The binding window is the one shown, and a nearly spent one is marked.
    expect(within(order[1]!).getByRole('img', { name: 'Codex: 96% of the session window used' }).querySelector('[data-high]')).not.toBeNull();
    expect(within(order[2]!).getByText('Local: no usage window')).toBeInTheDocument();
    const held = within(screen.getByRole('list', { name: 'Held back' })).getByRole('listitem');
    expect(held.textContent).toMatch(/Grok.*Signed out\. Eligible again: /);
    // A seat with no reading gets a hatched track and the word unknown, never a zero bar.
    expect(within(held).getByRole('img', { name: 'Grok usage unknown' })).toHaveAttribute('data-unknown');
    expect(container.textContent).not.toMatch(/\b0% of/);
    // One unlogged preview per kind of work, all for fleet work, and nothing else is asked of the router.
    expect(previews(fetch)).toHaveLength(15);
    expect(previews(fetch)).toEqual(expect.arrayContaining([routerPreviewPath('code', 'low', true), routerPreviewPath('leader', 'high', true)]));
    expect((fetch.mock.calls as unknown[][]).every(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET') === 'GET')).toBe(true);
  });

  it('draws every kind of work as a cell with its first seat, the next one and a count by seat', async () => {
    serve({ cell: (task, difficulty) => difficulty === 'high' ? (task === 'leader' ? NO_SEAT : decision({ seatId: 'codex-cmp', candidates: ['codex-cmp'] })) : undefined });
    render(<FleetRouterPane {...props} />);
    const table = await screen.findByRole('table', { name: 'Route table' });
    const cells = within(table).getAllByRole('button');
    expect(cells).toHaveLength(15);
    expect(cells.slice(0, 3).map(cell => cell.getAttribute('aria-label'))).toEqual([
      'Code, low: goes to Claude Max, then Codex', 'Code, medium: goes to Claude Max, then Codex', 'Code, high: goes to Codex']);
    expect(cells[2]!.textContent).toBe('Codexno second seat');
    expect(cells[2]!.querySelector('svg[data-provider]')?.getAttribute('data-provider')).toBe('codex');
    expect(within(table).getByRole('button', { name: 'Leader, high: no seat can take it' })).toHaveAttribute('data-route', 'none');
    // The chosen cell is the one tab stop; the rest are reached with the arrows.
    expect(cells.filter(cell => cell.tabIndex === 0).map(cell => cell.getAttribute('aria-label'))).toEqual(['Code, medium: goes to Claude Max, then Codex']);
    expect(within(table).getByRole('button', { pressed: true })).toBe(cells[1]);
    expect(within(screen.getByRole('list', { name: 'First choice by seat' })).getAllByRole('listitem').map(item => item.textContent)).toEqual([
      'Claude Max10', 'Codex4', 'No seat1', 'of 15 kinds of work']);
  });

  it('opens the chosen cell from the table already read, walks cells with the arrows, and reads again for your own request', async () => {
    const fetch = serve({ cell: (_task, difficulty, autonomous) => !autonomous ? decision({ seatId: 'codex-cmp', candidates: ['codex-cmp', 'claude'] })
      : difficulty === 'high' ? NO_SEAT : undefined });
    render(<FleetRouterPane {...props} />);
    await screen.findByText('Goes to Claude Max');
    const cell = (name: RegExp) => screen.getByRole('button', { name });
    cell(/^Code, medium/).focus();
    fireEvent.keyDown(cell(/^Code, medium/), { key: 'ArrowRight' });
    expect(cell(/^Code, high/)).toHaveFocus();
    fireEvent.click(cell(/^Code, high/));
    expect(screen.getByText('No seat can take this right now')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Next high code task' })).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Try order' })).toBeNull();
    fireEvent.keyDown(cell(/^Code, high/), { key: 'ArrowDown' });
    fireEvent.keyDown(cell(/^Review, high/), { key: 'Home' });
    expect(cell(/^Review, low/)).toHaveFocus();
    fireEvent.keyDown(cell(/^Review, low/), { key: 'ArrowLeft' });
    expect(cell(/^Review, low/)).toHaveFocus();
    fireEvent.click(cell(/^Review, low/));
    expect(screen.getByRole('heading', { name: 'Next low review task' })).toBeInTheDocument();
    // Choosing a cell asked nothing new.
    expect(previews(fetch)).toHaveLength(15);
    expect(screen.getByText(/Routed for autonomous fleet work\. Seat usage was read 3m ago\./)).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Routed for' })).getByRole('radio', { name: 'Your request' }));
    expect(await screen.findByText('Goes to Codex')).toBeInTheDocument();
    expect(screen.getByText(/Routed for your own request/)).toBeInTheDocument();
    expect(previews(fetch).filter(url => url.includes('autonomous=false'))).toHaveLength(15);
  });

  it('counts recorded decisions by chosen seat and lists the latest, flagging work that ran elsewhere', async () => {
    serve({ decisions: { decisions: [record(-0.1, 'claude', { engine: 'codex', seatId: 'codex-cmp' }), record(-1, 'claude'), record(-2, 'codex-cmp', { engine: 'codex', seatId: 'codex-cmp' }), record(-30, null)] } });
    render(<FleetRouterPane {...props} />);
    const bars = within(await screen.findByRole('list', { name: 'Decisions by chosen seat' })).getAllByRole('listitem');
    expect(bars.map(bar => bar.getAttribute('aria-label'))).toEqual(['Claude Max: 2 of 4 decisions', 'Codex: 1 of 4 decisions', 'No seat: 1 of 4 decisions']);
    expect(within(bars[0]!).getByText('2 · 50%')).toBeInTheDocument();
    expect(screen.getByText(/Last 4 recorded, since 1d ago\. 2 record the seat that ran; 1 of those ran on a different seat than the one chosen\./)).toBeInTheDocument();
    const latest = within(screen.getByRole('list', { name: 'Latest decisions' })).getAllByRole('listitem');
    expect(latest).toHaveLength(4);
    expect(latest[0]!.textContent).toMatch(/6m ago.*medium code · daemon.*Claude Max.*ran on Codex/);
    expect(latest[1]!.textContent).not.toMatch(/ran on/);
  });

  it('keeps every missing reading labelled unknown', async () => {
    serve({ fail: ['/budget'] });
    const first = render(<FleetRouterPane {...props} />);
    expect(await screen.findByText('Route table: unknown (the router did not answer).')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('Decision log: unknown (it could not be read).')).toBeInTheDocument();
    expect(screen.getByText(/Seat usage was read at an unknown time\./)).toBeInTheDocument();
    first.unmount(); evictAll();
    // The budget reading is down but the router answered: seats still list, their usage reads unknown.
    serve({ budget: { error: 'old server' } });
    render(<FleetRouterPane {...props} />);
    expect(await screen.findByText('Goes to claude')).toBeInTheDocument();
    expect(screen.getByText('Seat usage is unknown: the budget reading did not answer.')).toBeInTheDocument();
    expect(screen.getAllByText('Usage unknown').length).toBeGreaterThan(0);
    expect(await screen.findByText('No routing decisions are recorded yet.')).toBeInTheDocument();
  });

  it('refuses a body that is not a decision and marks a cell the router did not answer as unknown', async () => {
    serve({ cell: () => ({ schema: 'budget.view.v1', seats: [] }) });
    const first = render(<FleetRouterPane {...props} />);
    expect(await screen.findByText('Route table: unknown (the router did not answer).')).toBeInTheDocument();
    first.unmount(); evictAll();
    // One row's previews fail, and one cell answers with something that is not a decision.
    serve({ cell: (task, difficulty) => task === 'code' ? DOWN : task === 'plan' && difficulty === 'low' ? { seatId: 7 } : undefined });
    render(<FleetRouterPane {...props} />);
    expect(await screen.findByText('Unknown: the route table does not hold this kind of work.')).toBeInTheDocument();
    expect(within(screen.getByRole('table', { name: 'Route table' })).getAllByText('Unknown')).toHaveLength(4);
    expect(screen.getAllByRole('button')).toHaveLength(11);
    // The count by seat is of the cells answered, and the unanswered ones are counted in words, never as "No seat".
    expect(screen.getByText('4 of 15 kinds of work got no answer from the router.')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'First choice by seat' })).getAllByRole('listitem').map(item => item.textContent)).toEqual(['Claude Max11', 'of 11 kinds of work']);
  });

  it('registers as a fleet pane', () => {
    expect(listPanes().find(pane => pane.id === 'fleet-router')).toMatchObject({ title: 'Router', needsSession: false });
    expect(REGISTERED_DOCK_PANE_GROUPS['fleet-router']).toBe('fleet');
  });
});

describe('router-model', () => {
  it('orders tried seats before held ones and never turns a missing reading into a number', () => {
    const rows = routeSeats(decision(), VIEW);
    expect(rows.map(row => [row.seatId, row.rank, row.window, row.usedPercent])).toEqual([
      ['claude', 1, 'weekly', 23], ['codex-cmp', 2, 'session', 96], ['local:qwen3:8b', 3, null, null], ['grok', null, null, null]]);
    expect(rows[2]).toMatchObject({ free: true, label: 'qwen3:8b', brand: 'local' });
    expect(routeSeats(decision(), null).map(row => [row.label, row.usedPercent, row.resetAt])).toEqual([
      ['claude', null, null], ['codex-cmp', null, null], ['local:qwen3:8b', null, null], ['grok', null, null]]);
  });

  it('counts first choices by seat with no seat last, and finds a cell only when the table holds it', () => {
    const routes = routesOf((task, difficulty) => task === 'bulk' ? NO_SEAT : difficulty === 'low' ? decision({ seatId: 'grok' }) : undefined);
    expect(tableShares(routes)).toEqual([{ seatId: 'claude', count: 8 }, { seatId: 'grok', count: 4 }, { seatId: null, count: 3 }]);
    expect(tableShares([])).toEqual([]);
    expect(routeAt(routes, 'bulk', 'high')?.seatId).toBeNull();
    expect(routeAt([], 'code', 'medium')).toBeNull();
    expect(routerPreviewPath('plan', 'low', false)).toBe('/api/verse/budget/preview?task=plan&difficulty=low&autonomous=false');
  });

  it('summarizes an empty or undated log without inventing a span', () => {
    expect(summarizeDecisions([])).toEqual({ total: 0, from: null, to: null, seats: [], ranKnown: 0, ranElsewhere: 0 });
    const log = summarizeDecisions([{ ...record(0, 'claude'), at: 'not a time' }, record(-3, 'claude', { engine: 'claude', seatId: null })]);
    expect(log).toMatchObject({ total: 2, from: at(-3), to: at(-3), ranKnown: 0, ranElsewhere: 0, seats: [{ seatId: 'claude', count: 2, share: 1 }] });
    expect(ROUTER_DECISIONS_PATH).toBe('/api/verse/budget/decisions?limit=200');
  });
});
