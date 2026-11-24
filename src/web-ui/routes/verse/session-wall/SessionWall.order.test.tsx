import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { SessionWallPane, WallView } from './SessionWall.js';
import { barNote } from './WallBar.js';
import { narrowSessionWall, NO_SCOPE } from './session-wall-model.js';
import { arrangeEntries, forgetWallOrder, groupHeads, loadWallOrder, nextOrder, saveWallOrder, WALL_ORDER_KEY, WALL_ORDERS, type WallOrder } from './wall-order.js';
import { forgetWallSeen } from './wall-seen.js';
import { takeRequestedWallSession } from './wall-selection.js';
import { forgetWallView } from './wall-view-store.js';

const AT = '2026-11-20T12:00:00.000Z';
const session = (id: string, over: Record<string, unknown> = {}) => ({ id, kind: 'worker', agent: 'claude', lane: 'claude', model: 'fixture-model', repo: 'phantom',
  jobId: id, parentId: 'leader', state: 'running', lastMessageAgeSeconds: 120, prUrl: null, ...over });
const entry = (s: Record<string, unknown>) => ({ session: s, summary: [`${String(s.id)} summary.`], messageCount: 0, gaps: [], messages: [] });

/** In the fleet's order: the Leader, then each worker with its helper. */
const THREADS = [
  entry(session('leader', { kind: 'leader', lane: 'unknown', model: 'unknown', repo: 'unknown', jobId: null, parentId: null, state: 'idle', lastMessageAgeSeconds: 600 })),
  entry(session('RQ-A')),
  entry(session('RQ-A-help', { kind: 'subagent', lane: 'unknown', repo: 'unknown', jobId: null, parentId: 'RQ-A', state: 'done', lastMessageAgeSeconds: 5 })),
  entry(session('RQ-B', { lane: 'codex', repo: 'verse-site', state: 'quiet', lastMessageAgeSeconds: 30 })),
  entry(session('RQ-C', { lane: 'codex', state: 'done', lastMessageAgeSeconds: null })),
  entry(session('RQ-D', { lane: 'unknown', lastMessageAgeSeconds: 60 })),
];
const body = (threads: unknown[] = THREADS) => ({ schema: 'fleet.session-threads.v1', generatedAt: AT, filter: { lane: null, repo: null, live: false },
  counts: { sessions: threads.length }, threads, gaps: [] });
const read = (threads: unknown[] = THREADS) => narrowSessionWall(body(threads))!;
const ids = (order: WallOrder, threads: unknown[] = THREADS) => arrangeEntries(read(threads).entries, order).map(e => e.session.id);
const wallList = () => screen.getByRole('list', { name: 'Conversations' });
const shownIds = () => within(wallList()).getAllByRole('listitem').map(item => item.querySelector('strong')?.textContent);
const headings = () => within(wallList()).queryAllByRole('separator').map(head => head.getAttribute('aria-label'));
const orderBox = () => screen.getByRole('combobox', { name: 'Order' }) as HTMLSelectElement;
const railIds = () => [...screen.getByRole('navigation', { name: 'Every session' }).querySelectorAll<HTMLButtonElement>('button[data-rail]')].map(row => row.dataset.rail);

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
function serve() {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = new URL(String(input), 'http://localhost');
    if (!url.pathname.endsWith('/session-thread')) return json(body());
    const id = url.searchParams.get('id')!;
    return json({ schema: 'fleet.session-thread.v1', generatedAt: AT, id, session: THREADS.find(t => t.session.id === id)!.session, summary: [`${id} summary.`], messages: [], sources: {}, gaps: [] });
  }));
}
const mount = () => render(<SessionWallPane visible host={{ openPane: vi.fn() } as never} />);

beforeEach(() => { evictAll(); forgetWallSeen(); forgetWallView(); forgetWallOrder(); takeRequestedWallSession(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('the order of the sessions', () => {
  it('leaves the fleet order as the read gave it, the same array', () => {
    const entries = read().entries;
    expect(arrangeEntries(entries, 'fleet')).toBe(entries);
    expect(ids('fleet')).toEqual(['leader', 'RQ-A', 'RQ-A-help', 'RQ-B', 'RQ-C', 'RQ-D']);
  });

  it('puts the session that spoke last first, the Leader before all and an unknown time after all', () => {
    expect(ids('latest')).toEqual(['leader', 'RQ-A-help', 'RQ-B', 'RQ-D', 'RQ-A', 'RQ-C']);
    // Sessions that spoke at the same moment, or at no known one, keep the read's order.
    const tied = [entry(session('RQ-1', { lastMessageAgeSeconds: null })), entry(session('RQ-2')), entry(session('RQ-3', { lastMessageAgeSeconds: null })), entry(session('RQ-4'))];
    expect(ids('latest', tied)).toEqual(['RQ-2', 'RQ-4', 'RQ-1', 'RQ-3']);
  });

  it('groups by lane or repo: named ones A to Z, unknown last, a helper with its worker, the Leader on its own first', () => {
    expect(ids('lane')).toEqual(['leader', 'RQ-A', 'RQ-A-help', 'RQ-B', 'RQ-C', 'RQ-D']);
    expect(ids('repo')).toEqual(['leader', 'RQ-A', 'RQ-A-help', 'RQ-C', 'RQ-D', 'RQ-B']);
    // A helper whose worker is not listed stands under what its own record says.
    expect(ids('lane', [THREADS[2]!, THREADS[3]!])).toEqual(['RQ-B', 'RQ-A-help']);
    const laneHeads = groupHeads(arrangeEntries(read().entries, 'lane'), 'lane');
    expect([...laneHeads]).toEqual([
      ['leader', { name: null, label: 'Leader', count: '1 session: 1 idle' }],
      ['RQ-A', { name: 'claude', label: 'claude', count: '2 sessions: 1 running, 1 done' }],
      ['RQ-B', { name: 'codex', label: 'codex', count: '2 sessions: 1 quiet, 1 done' }],
      ['RQ-D', { name: null, label: 'lane unknown', count: '1 session: 1 running' }],
    ]);
    expect([...groupHeads(arrangeEntries(read().entries, 'repo'), 'repo')].map(([id, head]) => [id, head.label, head.count])).toEqual([
      ['leader', 'Leader', '1 session: 1 idle'], ['RQ-A', 'phantom', '4 sessions: 2 running, 2 done'], ['RQ-B', 'verse-site', '1 session: 1 quiet'],
    ]);
    expect(groupHeads(read().entries, 'fleet').size + groupHeads(read().entries, 'latest').size).toBe(0);
  });

  it('never adds or drops a session, whatever the order', () => {
    for (const order of WALL_ORDERS) expect([...ids(order)].sort()).toEqual([...ids('fleet')].sort());
    expect(WALL_ORDERS.map(nextOrder)).toEqual(['latest', 'lane', 'repo', 'fleet']);
  });

  it('keeps a chosen order, forgets the fleet order, and reads anything else as the fleet order', () => {
    expect(loadWallOrder()).toBe('fleet');
    expect(saveWallOrder('latest')).toBe(true);
    expect(loadWallOrder()).toBe('latest');
    expect(saveWallOrder('fleet')).toBe(true);
    expect(window.localStorage.getItem(WALL_ORDER_KEY)).toBeNull();
    window.localStorage.setItem(WALL_ORDER_KEY, 'loudest');
    expect(loadWallOrder()).toBe('fleet');
    expect(saveWallOrder('lane', null)).toBe(false);
    expect(loadWallOrder(null)).toBe('fleet');
    const denied = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } } as unknown as Storage;
    expect([loadWallOrder(denied), saveWallOrder('lane', denied)]).toEqual(['fleet', false]);
  });

  it('says what the order does under the bar, and nothing for the fleet order or a single session', () => {
    expect(barNote(read(), NO_SCOPE, '')).toBeNull();
    expect(barNote(read(), NO_SCOPE, '', 'latest')?.text).toBe('Latest first: the session that spoke most recently leads, one with no known time goes last');
    expect(barNote(read(), NO_SCOPE, 'codex', 'lane')?.text).toBe('2 of 6 on screen match · By lane: named lanes A to Z, a helper with its worker');
    expect(barNote(read([THREADS[1]!]), NO_SCOPE, '', 'latest')).toBeNull();
  });
});

describe('the wall in an order', () => {
  it('draws the cards in the order given, with a heading over each lane that counts the cards under it', () => {
    const { rerender } = render(<WallView read={read()} onOpen={vi.fn()} order="latest" />);
    expect(shownIds()).toEqual(['leader', 'RQ-A-help', 'RQ-B', 'RQ-D', 'RQ-A', 'RQ-C']);
    expect(headings()).toEqual([]);
    rerender(<WallView read={read()} onOpen={vi.fn()} order="lane" />);
    expect(shownIds()).toEqual(['leader', 'RQ-A', 'RQ-A-help', 'RQ-B', 'RQ-C', 'RQ-D']);
    expect(headings()).toEqual(['Leader, 1 session: 1 idle', 'claude, 2 sessions: 1 running, 1 done', 'codex, 2 sessions: 1 quiet, 1 done', 'lane unknown, 1 session: 1 running']);
    // One state only: the headings count what is left under them, a lane with nothing left has no heading,
    // and the helper stays under its worker's lane though the worker is filtered out.
    fireEvent.click(screen.getByRole('button', { name: /^done/ }));
    expect(shownIds()).toEqual(['RQ-A-help', 'RQ-C']);
    expect(headings()).toEqual(['claude, 1 session: 1 done', 'codex, 1 session: 1 done']);
  });

  it('moves between the cards of a grouped wall with the arrow keys, past the headings', () => {
    render(<WallView read={read()} onOpen={vi.fn()} order="repo" />);
    const cards = [...wallList().querySelectorAll<HTMLButtonElement>('button[data-card]')];
    cards[0]!.focus();
    fireEvent.keyDown(cards[0]!, { key: 'ArrowDown' });
    expect((document.activeElement as HTMLElement).dataset.card).toBe('RQ-A');
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect((document.activeElement as HTMLElement).dataset.card).toBe('RQ-B');
  });
});

describe('choosing the order in the Conversations pane', () => {
  it('changes the order from the bar, says what it does, and keeps it across a reload', async () => {
    serve();
    const first = mount();
    await waitFor(() => expect(shownIds()).toEqual(['leader', 'RQ-A', 'RQ-A-help', 'RQ-B', 'RQ-C', 'RQ-D']));
    expect(orderBox().value).toBe('fleet');
    expect([...orderBox().options].map(option => option.textContent)).toEqual(['Fleet order', 'Latest first', 'By lane', 'By repo']);
    fireEvent.change(orderBox(), { target: { value: 'latest' } });
    expect(shownIds()).toEqual(['leader', 'RQ-A-help', 'RQ-B', 'RQ-D', 'RQ-A', 'RQ-C']);
    expect(screen.getByRole('search').textContent).toContain('Latest first: the session that spoke most recently leads');
    expect(window.localStorage.getItem(WALL_ORDER_KEY)).toBe('latest');
    first.unmount();
    evictAll();
    mount();
    await waitFor(() => expect(shownIds()).toEqual(['leader', 'RQ-A-help', 'RQ-B', 'RQ-D', 'RQ-A', 'RQ-C']));
    expect(orderBox().value).toBe('latest');
    fireEvent.change(orderBox(), { target: { value: 'fleet' } });
    expect(shownIds()).toEqual(['leader', 'RQ-A', 'RQ-A-help', 'RQ-B', 'RQ-C', 'RQ-D']);
    expect(window.localStorage.getItem(WALL_ORDER_KEY)).toBeNull();
  });

  it('takes the next order on O, keeps the keyboard on the same card, and leaves O alone in the find box', async () => {
    serve();
    mount();
    await waitFor(() => expect(shownIds()).toHaveLength(6));
    const card = wallList().querySelector<HTMLButtonElement>('button[data-card="RQ-A"]')!;
    card.focus();
    fireEvent.keyDown(card, { key: 'o' });
    expect(orderBox().value).toBe('latest');
    expect(shownIds()[4]).toBe('RQ-A');
    expect((document.activeElement as HTMLElement).dataset.card).toBe('RQ-A');
    fireEvent.keyDown(document.activeElement!, { key: 'o' });
    expect(orderBox().value).toBe('lane');
    expect(headings()).toHaveLength(4);
    expect((document.activeElement as HTMLElement).dataset.card).toBe('RQ-A');
    fireEvent.keyDown(document.activeElement!, { key: 'o', metaKey: true });
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'o' });
    expect(orderBox().value).toBe('lane');
  });

  it('lists the sessions beside an open conversation in the same order, and steps through them in it', async () => {
    serve();
    window.localStorage.setItem(WALL_ORDER_KEY, 'latest');
    mount();
    await waitFor(() => expect(shownIds()).toHaveLength(6));
    fireEvent.click(wallList().querySelector<HTMLButtonElement>('button[data-card="RQ-B"]')!);
    await waitFor(() => expect(railIds()).toEqual(['leader', 'RQ-A-help', 'RQ-B', 'RQ-D', 'RQ-A', 'RQ-C']));
    fireEvent.keyDown(screen.getByRole('region', { name: 'Session RQ-B' }), { key: 'j' });
    await waitFor(() => expect(screen.getByRole('region', { name: 'Session RQ-D' })).toBeTruthy());
    fireEvent.keyDown(screen.getByRole('region', { name: 'Session RQ-D' }), { key: 'k' });
    fireEvent.keyDown(screen.getByRole('region', { name: 'Session RQ-B' }), { key: 'k' });
    await waitFor(() => expect(screen.getByRole('region', { name: 'Session RQ-A-help' })).toBeTruthy());
  });
});
