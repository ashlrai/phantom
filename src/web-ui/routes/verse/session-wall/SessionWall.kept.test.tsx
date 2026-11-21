import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { forgetThreadRead } from '../fleet-sessions/thread-read-store.js';
import { SessionWallPane } from './SessionWall.js';
import { forgetWallSeen, noteWallSeen, parseWallSeen, reloadWallSeen, unseenCount, WALL_SEEN_KEY } from './wall-seen.js';
import { takeRequestedWallSession } from './wall-selection.js';
import { forgetWallView } from './wall-view-store.js';

const AT = '2026-11-20T12:00:00.000Z';
const session = (id: string, over: Record<string, unknown> = {}) => ({ id, kind: 'worker', agent: 'claude', lane: 'claude', model: 'fixture-model', repo: 'phantom',
  jobId: id, parentId: 'leader', state: 'running', lastMessageAgeSeconds: 120, prUrl: null, ...over });
const message = (key: string, text: string) => ({ key, kind: key.split(':')[0], side: 'session', label: 'said', at: null, text, format: 'plain' });
const IDS = ['RQ-A', 'RQ-B'];
type Counts = Record<string, number>;
let counts: Counts = {};
let said: string[] = [];
const wall = () => ({ schema: 'fleet.session-threads.v1', generatedAt: AT, counts: { sessions: IDS.length }, gaps: [],
  threads: IDS.map(id => ({ session: session(id), summary: [`${id} is a worker.`], messages: [message('latest', `Latest from ${id}.`)], messageCount: counts[id] ?? 1, gaps: [] })) });
const thread = (id: string) => ({ schema: 'fleet.session-thread.v1', generatedAt: AT, id, session: session(id), summary: [`${id} summary.`],
  messages: said.map((text, index) => message(`bus:${index}`, text)), sources: {}, gaps: [] });
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const mount = () => render(<SessionWallPane visible host={{ openPane: vi.fn() } as never} />);
/** Closing the console and opening it again: nothing is left in memory, only what storage holds. */
function reload(view: ReturnType<typeof mount>) { view.unmount(); evictAll(); reloadWallSeen(); }
const card = (id: string) => screen.findByRole('button', { name: `${id}, running` });
const stored = () => JSON.parse(window.localStorage.getItem(WALL_SEEN_KEY) ?? 'null') as Counts | null;
const entry = (id: string, messageCount: number) => ({ session: { id }, messageCount });

beforeEach(() => {
  evictAll(); forgetWallSeen(); forgetWallView(); forgetThreadRead(); setMutationToken('a'.repeat(64)); takeRequestedWallSession();
  counts = {}; said = ['first'];
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = new URL(String(input), 'http://localhost');
    return json(url.pathname.endsWith('/session-thread') ? thread(url.searchParams.get('id')!) : wall());
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); clearMutationToken(); });

describe('the counts behind the "N new" marks, kept across a reload', () => {
  it('writes a count per session, reads it back, and writes again only when a count moved', () => {
    const set = vi.spyOn(Storage.prototype, 'setItem');
    noteWallSeen([entry('RQ-A', 2), entry('RQ-B', 5)], null);
    expect(stored()).toEqual({ 'RQ-A': 2, 'RQ-B': 5 });
    noteWallSeen([entry('RQ-A', 4), entry('RQ-B', 5)], null);
    // Growth is the mark itself, not a new starting count.
    expect(set).toHaveBeenCalledTimes(1);
    reloadWallSeen();
    expect(unseenCount(entry('RQ-A', 4), null)).toBe(2);
    expect(unseenCount(entry('RQ-B', 5), null)).toBe(0);
    // Opening it reads it; a session that left the read is forgotten.
    noteWallSeen([entry('RQ-A', 4)], 'RQ-A');
    expect(stored()).toEqual({ 'RQ-A': 4 });
  });

  it('drops what it cannot use and lasts as long as the window when storage refuses the write', () => {
    expect(parseWallSeen(null).size).toBe(0);
    expect(parseWallSeen('not json').size).toBe(0);
    expect(parseWallSeen('[3]').size).toBe(0);
    expect([...parseWallSeen(JSON.stringify({ a: 3, b: '4', c: -1, d: 1.5, e: null }))]).toEqual([['a', 3]]);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full'); });
    noteWallSeen([entry('RQ-A', 2)], null);
    expect(unseenCount(entry('RQ-A', 3), null)).toBe(1);
    expect(stored()).toBeNull();
  });
});

describe('the Conversations pane after a reload', () => {
  it('marks at once what arrived while the console was closed, and opens that conversation at the first new message', async () => {
    const first = mount();
    // Read RQ-A to its end, so the opening after the reload has a place to count from.
    fireEvent.click(await card('RQ-A'));
    await screen.findByText('first');
    fireEvent.click(screen.getByRole('button', { name: 'Back to every conversation' }));
    await card('RQ-A');
    expect(screen.queryByText(/\d new$/)).toBeNull();
    expect(stored()).toEqual({ 'RQ-A': 1, 'RQ-B': 1 });

    reload(first);
    counts = { 'RQ-A': 3 };
    said = ['first', 'second', 'third'];
    mount();
    // The first read after the reload already carries the mark: no second read is needed to notice growth.
    expect(within(await card('RQ-A')).getByText('2 new')).toBeTruthy();
    expect(within(await card('RQ-B')).queryByText(/new$/)).toBeNull();
    expect(screen.getByRole('button', { name: /new messages/ }).textContent).toBe('1 conversation has new messages N');

    fireEvent.click(await card('RQ-A'));
    const log = await screen.findByRole('list', { name: 'Conversation with RQ-A' });
    await waitFor(() => expect([...log.children].map(item => (item.hasAttribute('data-new-mark') ? 'NEW' : item.textContent?.replace(/^said/, '')))).toEqual(['first', 'NEW', 'second', 'third']));
    expect(screen.getByRole('button', { name: '2 new messages, go to the first' })).toBeTruthy();
    // Opened, so the card's count is settled for the next reload.
    await waitFor(() => expect(stored()).toEqual({ 'RQ-A': 3, 'RQ-B': 1 }));
  });
});
