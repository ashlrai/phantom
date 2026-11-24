/** Router pane seats board: where each seat stands for every kind of work, its usage windows, its fleet standing, and every unknown state. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { BudgetView } from '../../../../core/routing/policy.js';
import type { SeatDecision, SeatHeadroom } from '../../../../core/routing/types.js';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetRouterPane } from './FleetRouterPane.js';
import { ROUTER_DIFFICULTIES, ROUTER_TASKS, type BudgetRoute } from './router-model.js';
import { cellWords, fleetWords, poolWords, seatPool, standingWords, windowWords } from './seat-pool-model.js';

const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const at = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
const headroom = (seatId: string, patch: Partial<SeatHeadroom>): SeatHeadroom => ({ seatId, sessionUsedPercent: null, weeklyUsedPercent: null,
  bindingWindow: null, autonomyHeadroomPercent: null, resetAt: null, eligibleForAutonomy: true, reasons: [], ...patch });
const VIEW = {
  sampledAt: at(-0.05),
  seatInfo: [{ seatId: 'claude', label: 'Claude Max', engine: 'claude', free: false }, { seatId: 'codex-cmp', label: 'Codex', engine: 'codex', free: false },
    { seatId: 'local:qwen3:8b', label: 'qwen3:8b', engine: 'local', free: true }, { seatId: 'grok', label: 'Grok', engine: 'grok', free: false }],
  headroom: [headroom('claude', { weeklyUsedPercent: 23, bindingWindow: 'weekly', resetAt: at(44), autonomyHeadroomPercent: 37 }),
    headroom('codex-cmp', { sessionUsedPercent: 96, weeklyUsedPercent: 40, bindingWindow: 'session', resetAt: at(2) }),
    headroom('local:qwen3:8b', {}), headroom('grok', { eligibleForAutonomy: false, reasons: ['Grok is signed out'] })],
} as unknown as BudgetView;
const GROK_OUT = { seatId: 'grok', reasons: ['Signed out.'], nextEligibleAt: null, details: [{ kind: 'signed-out' as const, text: 'Signed out.' }] };
const decision = (patch: Partial<SeatDecision> = {}): SeatDecision => ({ seatId: 'claude', candidates: ['claude', 'codex-cmp', 'local:qwen3:8b'], mode: 'balanced',
  why: 'Claude Max has the most headroom.', summary: 'Claude Max has the most headroom', exclusions: [GROK_OUT], ...patch });
/** High difficulty goes to Codex alone with Claude held back; nothing can lead at high difficulty. */
const HIGH = decision({ seatId: 'codex-cmp', candidates: ['codex-cmp'], exclusions: [GROK_OUT, { seatId: 'claude', reasons: ['Kept for your own work.'], nextEligibleAt: null }] });
const NO_SEAT = decision({ seatId: null, candidates: [], exclusions: [GROK_OUT] });
const cellOf = (task: string, difficulty: string): SeatDecision => difficulty !== 'high' ? decision() : task === 'leader' ? NO_SEAT : HIGH;
/** Every kind of work but low plan, which the router did not answer. */
const ROUTES: BudgetRoute[] = ROUTER_TASKS.flatMap(task => ROUTER_DIFFICULTIES.map(difficulty => ({ task: task.value, difficulty: difficulty.value, decision: cellOf(task.value, difficulty.value) })))
  .filter(route => !(route.task === 'plan' && route.difficulty === 'low'));

const DOWN = Symbol('down');
const serve = (routes: { cell?: (task: string, difficulty: string) => unknown; budget?: unknown } = {}) => {
  const fetch = vi.fn(async (input: string) => {
    const url = String(input);
    if (url.includes('/budget/preview')) {
      const query = new URL(url, 'http://localhost').searchParams;
      const body = (routes.cell ?? cellOf)(query.get('task') ?? '', query.get('difficulty') ?? '');
      return body === DOWN ? Response.json({ error: 'down' }, { status: 500 }) : Response.json(body);
    }
    if (url.includes('/budget/decisions')) return Response.json({ decisions: [] });
    if (url.includes('/api/verse/budget')) return Response.json(routes.budget ?? VIEW);
    return Response.json({}, { status: 404 });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
};
const props = { visible: true } as PaneProps;
const rowsOf = async () => within(await screen.findByRole('list', { name: 'Seats' })).getAllByRole('listitem');
const standings = (row: HTMLElement) => within(row).getAllByRole('button').map(cell => cell.getAttribute('data-standing'));
beforeEach(() => { evictAll(); vi.spyOn(Date, 'now').mockReturnValue(NOW); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('seat-pool-model', () => {
  it('counts where each seat stands across the cells answered, the seat carrying the most first', () => {
    const pool = seatPool(ROUTES, VIEW);
    expect(pool.seats.map(seat => [seat.label, seat.first, seat.later, seat.held])).toEqual([['Claude Max', 9, 0, 4], ['Codex', 4, 9, 0], ['qwen3:8b', 0, 9, 0], ['Grok', 0, 0, 14]]);
    expect(pool).toMatchObject({ answered: 14, taking: 2, standby: 1, out: 1 });
    expect(poolWords(pool)).toBe('4 seats: 2 take work first, 1 only as a later try, 1 in no try order.');
    expect(pool.seats.map(seat => standingWords(seat, pool.answered))).toEqual(['First for 9 of 14, held back from 4', 'First for 4 of 14, a later try for 9', 'A later try for 9', 'Held back from 14']);
    const [claude, codex, local] = pool.seats;
    // Code: low, medium, high. Claude leads the first two and is held back from the third, with the router's reason.
    expect(claude!.cells.slice(0, 3).map(cell => [cell.standing, cell.rank])).toEqual([['first', 1], ['first', 1], ['held', null]]);
    expect(cellWords(claude!, claude!.cells[2]!)).toBe('Claude Max, code high: held back. Kept for your own work.');
    expect(cellWords(codex!, codex!.cells[0]!)).toBe('Codex, code low: tried 2nd');
    expect(cellWords(local!, local!.cells[1]!)).toBe('qwen3:8b, code medium: tried 3rd');
    // A seat the router answered about without naming it is "not named"; a cell with no answer is unknown for every seat.
    expect(cellWords(local!, local!.cells[2]!)).toBe('qwen3:8b, code high: not named by the router');
    expect(pool.seats.map(seat => seat.cells[6]!.standing)).toEqual(['unknown', 'unknown', 'unknown', 'unknown']);
    expect(cellWords(codex!, codex!.cells[6]!)).toBe('Codex, plan low: no answer from the router');
  });

  it('copies the windows that hold a reading and only the binding window\'s reset', () => {
    const [claude, codex, local, grok] = seatPool(ROUTES, VIEW).seats;
    expect(claude!.windows).toEqual([{ name: 'weekly', usedPercent: 23, binding: true, resetAt: at(44) }]);
    expect(codex!.windows).toEqual([{ name: 'session', usedPercent: 96, binding: true, resetAt: at(2) }, { name: 'weekly', usedPercent: 40, binding: false, resetAt: null }]);
    expect(codex!.windows.map(windowWords)).toEqual(['Session: 96% used', 'Weekly: 40% used']);
    expect(local).toMatchObject({ free: true, brand: 'local', windows: [] });
    // No reading is no window, never a zero.
    expect(grok!.windows).toEqual([]);
    expect(fleetWords(claude!)).toBe('Open to fleet work, which may use 37% more of the weekly window.');
    expect(fleetWords(codex!)).toBe('Open to fleet work.');
    expect(fleetWords(grok!)).toBe('Closed to fleet work. Grok is signed out.');
  });

  it('lists seats from the route table alone when the budget reading is missing, and says what it cannot know', () => {
    const pool = seatPool(ROUTES, null);
    expect(pool.seats.map(seat => seat.label)).toEqual(['claude', 'codex-cmp', 'local:qwen3:8b', 'grok']);
    expect(pool.seats.every(seat => seat.windows.length === 0 && seat.fleet === null && !seat.free)).toBe(true);
    expect(fleetWords(pool.seats[0]!)).toBe('Fleet standing unknown: the budget reading does not name this seat.');
    expect(poolWords(seatPool([], null))).toBe('The router and the budget reading name no seat.');
    // A seat the budget reading names and no cell mentions still gets a row.
    const quiet = seatPool([], VIEW);
    expect(quiet.seats).toHaveLength(4);
    expect(standingWords(quiet.seats[0]!, quiet.answered)).toBe('Standing unknown');
    expect(standingWords({ ...quiet.seats[0]!, first: 0, later: 0, held: 0 }, 14)).toBe('Not named for any kind of work');
  });
});

describe('Router pane seats board', () => {
  it('draws a row per seat with its mark, standing, a cell per kind of work, usage windows and fleet standing', async () => {
    serve({ cell: (task, difficulty) => task === 'plan' && difficulty === 'low' ? DOWN : cellOf(task, difficulty) });
    const { container } = render(<FleetRouterPane {...props} />);
    const rows = await rowsOf();
    expect(screen.getByRole('heading', { name: 'Seats the router balances across' })).toBeInTheDocument();
    expect(screen.getByText('4 seats: 2 take work first, 1 only as a later try, 1 in no try order.')).toBeInTheDocument();
    expect(rows.map(row => row.getAttribute('data-seat'))).toEqual(['claude', 'codex-cmp', 'local:qwen3:8b', 'grok']);
    expect(rows.map(row => row.querySelector('svg[data-provider]')?.getAttribute('data-provider'))).toEqual(['claude', 'codex', 'local', 'grok']);
    expect(within(rows[0]!).getByText('First for 9 of 14, held back from 4')).toBeInTheDocument();
    expect(standings(rows[0]!)).toEqual(['first', 'first', 'held', 'first', 'first', 'held', 'unknown', 'first', 'held', 'first', 'first', 'held', 'first', 'first', 'unnamed']);
    expect(standings(rows[1]!).slice(0, 3)).toEqual(['later', 'later', 'first']);
    // A later try carries its place in the order; a held-back cell a dash; the rest are read by shape.
    expect(within(rows[1]!).getByRole('button', { name: 'Codex, code low: tried 2nd' })).toHaveTextContent('2');
    expect(within(rows[3]!).getByRole('button', { name: 'Grok, code low: held back. Signed out.' })).toHaveTextContent('–');
    expect(rows[3]).toHaveAttribute('data-idle');
    // Both windows the reading holds are drawn; only the one that binds fleet work says its reset.
    const session = within(rows[1]!).getByRole('meter', { name: 'Codex session window used' });
    expect(session).toHaveAttribute('aria-valuenow', '96');
    expect(session.getAttribute('aria-valuetext')).toMatch(/^Session: 96% used, binds fleet work · resets /);
    expect(within(rows[1]!).getByRole('meter', { name: 'Codex weekly window used' })).toHaveAttribute('aria-valuetext', 'Weekly: 40% used');
    expect(rows[1]!.querySelectorAll('[data-binding]')).toHaveLength(1);
    expect(within(rows[0]!).getByText('Open to fleet work, which may use 37% more of the weekly window.')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Local: no usage window')).toBeInTheDocument();
    // No reading is a hatched bar and the word unknown, never a zero.
    expect(within(rows[3]!).getByRole('meter', { name: 'Grok usage' })).toHaveAttribute('data-unread');
    expect(within(rows[3]!).getByText('Closed to fleet work. Grok is signed out.')).toHaveAttribute('data-fleet', 'closed');
    expect(container.textContent).not.toMatch(/\b0% /);
    expect(container.querySelector('[data-pool-key]')?.textContent).toBe('First choice2A later try, with its place–Held backNot namedNo answerEach group reads low, medium, high.');
  });

  it('rings the kind of work chosen in the route table down every row, and choosing a cell here chooses it there', async () => {
    const fetch = serve();
    render(<FleetRouterPane {...props} />);
    const rows = await rowsOf();
    const ringed = () => rows.map(row => within(row).getByRole('button', { pressed: true }).getAttribute('aria-label'));
    expect(ringed()).toEqual(['Claude Max, code medium: first choice', 'Codex, code medium: tried 2nd', 'qwen3:8b, code medium: tried 3rd', 'Grok, code medium: held back. Signed out.']);
    fireEvent.click(within(rows[2]!).getByRole('button', { name: 'qwen3:8b, bulk high: not named by the router' }));
    expect(screen.getByRole('heading', { name: 'Next high bulk task' })).toBeInTheDocument();
    expect(screen.getByText('Goes to Codex')).toBeInTheDocument();
    expect(within(screen.getByRole('table', { name: 'Route table' })).getByRole('button', { pressed: true })).toHaveAccessibleName('Bulk, high: goes to Codex');
    expect(ringed()[0]).toBe('Claude Max, bulk high: held back. Kept for your own work.');
    // The table follows the other way too.
    fireEvent.click(screen.getByRole('button', { name: /^Review, low/ }));
    expect(ringed()[1]).toBe('Codex, review low: tried 2nd');
    // Choosing here asked the router nothing new.
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('/budget/preview'))).toHaveLength(15);
  });

  it('is one tab stop whose cells the arrows walk: along a seat\'s kinds of work and from seat to seat', async () => {
    serve();
    render(<FleetRouterPane {...props} />);
    const board = await screen.findByRole('list', { name: 'Seats' });
    const stops = within(board).getAllByRole('button').filter(cell => cell.tabIndex === 0);
    expect(stops.map(cell => cell.getAttribute('aria-label'))).toEqual(['Claude Max, code medium: first choice']);
    stops[0]!.focus();
    fireEvent.keyDown(stops[0]!, { key: 'ArrowRight' });
    expect(within(board).getByRole('button', { name: /^Claude Max, code high/ })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(within(board).getByRole('button', { name: 'Codex, code high: first choice' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(within(board).getByRole('button', { name: /^Codex, leader high/ })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(within(board).getByRole('button', { name: /^Codex, leader high/ })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(within(board).getByRole('button', { name: 'Claude Max, code low: first choice' })).toHaveFocus();
    // A held modifier is someone else's shortcut.
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight', metaKey: true });
    expect(within(board).getByRole('button', { name: 'Claude Max, code low: first choice' })).toHaveFocus();
  });

  it('still lists the seats the router names when the budget reading is down, with usage and fleet standing unknown', async () => {
    serve({ budget: { error: 'old server' } });
    render(<FleetRouterPane {...props} />);
    const rows = await rowsOf();
    expect(rows.map(row => row.getAttribute('data-seat'))).toEqual(['claude', 'codex-cmp', 'local:qwen3:8b', 'grok']);
    for (const row of rows) {
      expect(within(row).getByRole('meter')).toHaveAttribute('data-unread');
      expect(within(row).getByText('Usage unknown')).toBeInTheDocument();
      expect(within(row).getByText('Fleet standing unknown: the budget reading does not name this seat.')).toHaveAttribute('data-fleet', 'unknown');
    }
  });
});
