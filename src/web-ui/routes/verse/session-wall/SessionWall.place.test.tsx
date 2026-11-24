import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll, refetchQuery } from '../../../data/cache.js';
import { SessionWallPane } from './SessionWall.js';
import { newLabel, railEntries, railStep } from './SessionRail.js';
import { narrowSessionWall, NO_SCOPE, sessionWallQuery, type WallScope } from './session-wall-model.js';
import { forgetWallSeen, nextUnseen, noteWallSeen, unseenSessions } from './wall-seen.js';
import { takeRequestedWallSession } from './wall-selection.js';
import { forgetWallView, loadWallView, parseWallView, saveWallView, WALL_VIEW_KEY } from './wall-view-store.js';

const AT = '2026-11-20T12:00:00.000Z';
const session = (id: string, over: Record<string, unknown> = {}) => ({ id, kind: 'worker', agent: 'claude', lane: 'claude', model: 'fixture-model', repo: 'phantom',
  jobId: id, parentId: 'leader', state: 'running', lastMessageAgeSeconds: 120, prUrl: null, ...over });
const message = (key: string, side: string, label: string, text: string) => ({ key, kind: key.split(':')[0], side, label, at: null, text, format: 'plain' });
const LEADER = session('leader', { kind: 'leader', lane: 'unknown', model: 'unknown', repo: 'unknown', jobId: null, parentId: null, state: 'idle' });
const SESSIONS = [
  { session: LEADER, summary: ['leader is the leader.'], messages: [message('owner:1', 'other', 'Mason', 'Ship the wall today.')] },
  { session: session('RQ-A'), summary: ['RQ-A is a worker on claude.'], messages: [message('latest', 'session', 'RQ-A', 'Running the web suite now.')] },
  { session: session('RQ-B', { lane: 'codex', repo: 'verse-site', state: 'quiet' }), summary: ['RQ-B is a worker on codex.'], messages: [message('latest', 'session', 'RQ-B', 'Waiting on the build.')] },
  { session: session('RQ-C', { lane: 'codex', state: 'done' }), summary: ['RQ-C finished.'], messages: [message('step:1', 'record', 'Step 1', 'Opened the pull request')] },
];
type Counts = Record<string, number>;
/** GET /api/verse/fleet/control/session-threads narrowed the way the route narrows, each session holding `counts[id]` messages (1 when not given). */
function answer(scope: WallScope, counts: Counts = {}) {
  const threads = SESSIONS.filter(({ session: s }) => (!scope.lane || s.lane === scope.lane) && (!scope.repo || s.repo === scope.repo) && (!scope.live || s.state !== 'done'))
    .map(entry => ({ ...entry, messageCount: counts[entry.session.id] ?? 1, gaps: [] }));
  return { schema: 'fleet.session-threads.v1', generatedAt: AT, filter: scope, counts: { sessions: threads.length }, threads, gaps: [] };
}
const thread = (id: string) => ({ schema: 'fleet.session-thread.v1', generatedAt: AT, id, session: SESSIONS.find(entry => entry.session.id === id)!.session,
  summary: [`${id} summary.`], messages: [message('latest', 'session', id, `Latest from ${id}.`)], sources: {}, gaps: [] });
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
function serve(counts: () => Counts = () => ({})) {
  const fetch = vi.fn(async (input: unknown, _init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname.endsWith('/session-thread')) return json(thread(url.searchParams.get('id')!));
    return json(answer({ lane: url.searchParams.get('lane'), repo: url.searchParams.get('repo'), live: url.searchParams.get('live') === '1' }, counts()));
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const walls = (fetch: ReturnType<typeof serve>) => [...new Set(fetch.mock.calls.map(call => String(call[0])).filter(url => url.includes('/session-threads')))];
const read = (counts: Counts = {}) => narrowSessionWall(answer(NO_SCOPE, counts))!;
const reread = () => act(() => refetchQuery(sessionWallQuery.key, () => sessionWallQuery.fetch(new AbortController().signal), true));
const mount = () => render(<SessionWallPane visible host={{ openPane: vi.fn() } as never} />);
const shownIds = () => within(screen.getByRole('list', { name: 'Conversations' })).getAllByRole('listitem').map(item => item.querySelector('strong')?.textContent);
const findBox = () => screen.getByRole('searchbox', { name: 'Find in the conversations on screen' }) as HTMLInputElement;
const rail = () => screen.getByRole('navigation', { name: 'Every session' });
const railIds = () => [...rail().querySelectorAll<HTMLButtonElement>('button[data-rail]')].map(row => row.dataset.rail);
const openRegion = () => screen.getByRole('region').getAttribute('aria-label');
const onConversation = () => waitFor(() => expect(document.activeElement).toBe(screen.getByRole('region')));
const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(document.activeElement!, { key, ...init });
const stored = () => window.localStorage.getItem(WALL_VIEW_KEY);

beforeEach(() => { evictAll(); forgetWallSeen(); forgetWallView(); setMutationToken('a'.repeat(64)); takeRequestedWallSession(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); clearMutationToken(); });

describe('the kept view of the Conversations pane', () => {
  it('reads back what was kept, and treats anything unusable as the unnarrowed wall', () => {
    const everything = { find: '', scope: NO_SCOPE };
    expect(parseWallView(null)).toEqual(everything);
    expect(parseWallView('not json')).toEqual(everything);
    expect(parseWallView('[1]')).toEqual(everything);
    expect(parseWallView(JSON.stringify({ find: 7, scope: 'codex' }))).toEqual(everything);
    expect(parseWallView(JSON.stringify({ find: 'web suite', scope: { lane: 'codex', repo: 'verse-site', live: true } })))
      .toEqual({ find: 'web suite', scope: { lane: 'codex', repo: 'verse-site', live: true } });
    // A lane the route would refuse as a filter is never sent back to it; "unknown" is not a lane.
    expect(parseWallView(JSON.stringify({ scope: { lane: 'two words', repo: 'unknown', live: 'yes' } }))).toEqual(everything);
    expect(parseWallView(JSON.stringify({ find: 'x'.repeat(500) })).find).toHaveLength(200);
  });

  it('keeps a narrowed view, forgets an unnarrowed one, and says when it could not be written', () => {
    expect(saveWallView({ find: '', scope: { ...NO_SCOPE, live: true } })).toBe(true);
    expect(loadWallView()).toEqual({ find: '', scope: { lane: null, repo: null, live: true } });
    expect(saveWallView({ find: '  ', scope: NO_SCOPE })).toBe(true);
    expect(stored()).toBeNull();
    const full = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('full'); }, removeItem: () => {} } as unknown as Storage;
    expect(saveWallView({ find: 'codex', scope: NO_SCOPE }, full)).toBe(false);
    expect(saveWallView({ find: 'codex', scope: NO_SCOPE }, null)).toBe(false);
    expect(loadWallView(full)).toEqual({ find: '', scope: NO_SCOPE });
    expect(loadWallView(null)).toEqual({ find: '', scope: NO_SCOPE });
  });

  it('opens the pane the way it was left: the lane asked of the server first, the words back in the find box', async () => {
    window.localStorage.setItem(WALL_VIEW_KEY, JSON.stringify({ find: 'finished', scope: { lane: 'codex', repo: null, live: false } }));
    const fetch = serve();
    mount();
    await waitFor(() => expect(shownIds()).toEqual(['RQ-C']));
    // The unnarrowed list is never asked for on the way.
    expect(walls(fetch)).toEqual(['/api/verse/fleet/control/session-threads?lane=codex']);
    expect(findBox().value).toBe('finished');
    expect((screen.getByRole('combobox', { name: 'Lane' }) as HTMLSelectElement).value).toBe('codex');
    expect(within(screen.getByRole('search')).getByRole('status').textContent).toBe('1 of 2 on screen match · Showing lane codex');

    // Every change is kept as it is made; back at every session with an empty box, nothing is kept.
    fireEvent.click(screen.getByRole('button', { name: 'Every session' }));
    await waitFor(() => expect(JSON.parse(stored()!)).toEqual({ find: 'finished', scope: NO_SCOPE }));
    fireEvent.keyDown(findBox(), { key: 'Escape' });
    await waitFor(() => expect(stored()).toBeNull());
    await waitFor(() => expect(shownIds()).toEqual(['leader', 'RQ-A', 'RQ-B', 'RQ-C']));
  });

  it('keeps what is typed and chosen for the next time the pane opens', async () => {
    serve();
    const first = mount();
    await screen.findByRole('button', { name: 'RQ-A, running' });
    fireEvent.change(findBox(), { target: { value: 'codex' } });
    fireEvent.click(screen.getByRole('button', { name: 'Running only' }));
    await waitFor(() => expect(shownIds()).toEqual(['RQ-B']));
    expect(JSON.parse(stored()!)).toEqual({ find: 'codex', scope: { lane: null, repo: null, live: true } });
    first.unmount();
    mount();
    await waitFor(() => expect(shownIds()).toEqual(['RQ-B']));
    expect(findBox().value).toBe('codex');
    expect(screen.getByRole('button', { name: 'Running only' }).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('the list beside an open conversation, narrowed by the find words', () => {
  it('lists only the sessions holding the words, says how many, and brings the rest back', async () => {
    serve();
    mount();
    await screen.findByRole('button', { name: 'RQ-A, running' });
    fireEvent.change(findBox(), { target: { value: 'codex' } });
    fireEvent.click(screen.getByRole('button', { name: 'RQ-B, quiet' }));
    expect(railIds()).toEqual(['RQ-B', 'RQ-C']);
    expect(within(rail()).getByRole('status').textContent).toBe('2 of 4 listed: holding “codex”, or open.Show all');
    // J and K walk the rows shown, not the sessions left out.
    await onConversation();
    press('k'); expect(openRegion()).toBe('Session RQ-B');
    press('j'); expect(openRegion()).toBe('Session RQ-C');
    press('j'); expect(openRegion()).toBe('Session RQ-C');

    fireEvent.click(within(rail()).getByRole('button', { name: 'Show all' }));
    expect(railIds()).toEqual(['leader', 'RQ-A', 'RQ-B', 'RQ-C']);
    expect(within(rail()).queryByRole('status')).toBeNull();
    // The words are gone from the wall as well, and from what is kept.
    fireEvent.click(screen.getByRole('button', { name: 'Back to every conversation' }));
    await waitFor(() => expect(shownIds()).toEqual(['leader', 'RQ-A', 'RQ-B', 'RQ-C']));
    expect(findBox().value).toBe('');
    expect(stored()).toBeNull();
  });

  it('keeps the open conversation in the list even when it does not hold the words', () => {
    const ids = (find: string, openId: string) => railEntries(read(), find, openId).map(entry => entry.session.id);
    expect(ids('', 'RQ-A')).toEqual(['leader', 'RQ-A', 'RQ-B', 'RQ-C']);
    expect(ids('codex', 'RQ-B')).toEqual(['RQ-B', 'RQ-C']);
    expect(ids('codex', 'RQ-A')).toEqual(['RQ-A', 'RQ-B', 'RQ-C']);
    expect(ids('codex', 'RQ-GONE')).toEqual(['RQ-B', 'RQ-C']);
    expect(railEntries(null, 'codex', 'RQ-A')).toEqual([]);
    expect(railStep(read(), 'RQ-A', 1, 'codex')).toBe('RQ-B');
    expect(railStep(read(), 'RQ-A', -1, 'codex')).toBeNull();
    expect(railStep(read(), 'RQ-GONE', -1, 'codex')).toBe('RQ-C');
  });
});

describe('going to the next conversation with new messages', () => {
  it('finds the next one after the open conversation, going round, and none when nothing is new', () => {
    const before = read().entries;
    noteWallSeen(before, null);
    expect(nextUnseen(before, null)).toBeNull();
    expect(unseenSessions(before, null)).toBe(0);
    const after = read({ leader: 3, 'RQ-B': 2 }).entries;
    expect(unseenSessions(after, null)).toBe(2);
    expect(nextUnseen(after, null)).toBe('leader');
    expect(nextUnseen(after, 'leader')).toBe('RQ-B');
    expect(nextUnseen(after, 'RQ-A')).toBe('RQ-B');
    // Past the last one it starts again from the top; the open conversation itself never counts.
    expect(nextUnseen(after, 'RQ-C')).toBe('leader');
    expect(nextUnseen(after, 'RQ-B')).toBe('leader');
    expect(unseenSessions(after, 'RQ-B')).toBe(1);
    expect(nextUnseen(after, 'RQ-GONE')).toBe('leader');
    expect(nextUnseen([], null)).toBeNull();
    expect([newLabel(1), newLabel(3)]).toEqual(['1 conversation has new messages', '3 conversations have new messages']);
  });

  it('offers it above the cards only while something is new, and N opens each in turn', async () => {
    let counts: Counts = {};
    serve(() => counts);
    mount();
    const card = await screen.findByRole('button', { name: 'RQ-A, running' });
    expect(screen.queryByRole('button', { name: /new messages/ })).toBeNull();
    // With nothing new, N is not taken.
    card.focus();
    expect(press('n')).toBe(true);
    expect(screen.getByRole('list', { name: 'Conversations' })).toBeTruthy();

    counts = { 'RQ-A': 4, 'RQ-C': 2 };
    await reread();
    expect((await screen.findByRole('button', { name: /new messages/ })).textContent).toBe('2 conversations have new messages N');
    // Typing an n in the find box is a letter, not the shortcut.
    fireEvent.keyDown(findBox(), { key: 'n' });
    expect(screen.getByRole('list', { name: 'Conversations' })).toBeTruthy();

    card.focus();
    expect(press('n')).toBe(false);
    expect(openRegion()).toBe('Session RQ-A');
    // Beside the open conversation the count is what is left; N goes on to it, and then there is nothing to go to.
    expect(within(rail()).getByRole('button', { name: /new messages/ }).textContent).toBe('1 conversation has new messages N');
    await onConversation();
    press('n', { metaKey: true }); expect(openRegion()).toBe('Session RQ-A');
    press('n'); expect(openRegion()).toBe('Session RQ-C');
    await waitFor(() => expect(within(rail()).queryByRole('button', { name: /new messages/ })).toBeNull());
    await onConversation();
    press('n'); expect(openRegion()).toBe('Session RQ-C');
  });

  it('opens the first one from the button, and counts only the cards the find words leave', async () => {
    let counts: Counts = {};
    serve(() => counts);
    mount();
    await screen.findByRole('button', { name: 'RQ-A, running' });
    counts = { 'RQ-A': 4, 'RQ-C': 2 };
    await reread();
    await screen.findByRole('button', { name: /new messages/ });
    fireEvent.change(findBox(), { target: { value: 'codex' } });
    expect(screen.getByRole('button', { name: /new messages/ }).textContent).toBe('1 conversation has new messages N');
    fireEvent.click(screen.getByRole('button', { name: /new messages/ }));
    expect(openRegion()).toBe('Session RQ-C');
    // RQ-A holds new messages too, but the words leave it out of the list, so nothing is offered here.
    expect(railIds()).toEqual(['RQ-B', 'RQ-C']);
    await waitFor(() => expect(within(rail()).queryByRole('button', { name: /new messages/ })).toBeNull());
  });
});
