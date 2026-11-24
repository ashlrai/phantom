import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll, refetchQuery } from '../../../data/cache.js';
import { forgetThreadRead } from '../fleet-sessions/thread-read-store.js';
import { SessionWallPane } from './SessionWall.js';
import { NO_SCOPE, sessionWallQuery, type WallScope } from './session-wall-model.js';
import { forgetWallSeen } from './wall-seen.js';
import { takeRequestedWallSession } from './wall-selection.js';
import { forgetWallView } from './wall-view-store.js';
import { forgetWallLeader, LEADER_SESSION_ID, leaderIdOf, leaderRoom, loadLeaderHidden, OPEN_LEADER_MIN_PX, saveLeaderHidden, WALL_LEADER_KEY, WALL_LEADER_MIN_PX } from './wall-leader.js';

const AT = '2026-11-20T12:00:00.000Z';
const INBOX = '/api/verse/leader/inbox';
const session = (id: string, over: Record<string, unknown> = {}) => ({ id, kind: 'worker', agent: 'claude', lane: 'claude', model: 'fixture-model', repo: 'phantom',
  jobId: id, parentId: 'leader', state: 'running', lastMessageAgeSeconds: 120, prUrl: null, ...over });
const message = (key: string, side: string, label: string, text: string) => ({ key, kind: key.split(':')[0], side, label, at: null, text, format: 'plain' });
const LEADER = session('leader', { kind: 'leader', lane: 'unknown', model: 'unknown', repo: 'unknown', jobId: null, parentId: null, state: 'idle' });
const SESSIONS = [
  { session: LEADER, summary: ['leader is the leader.'], messages: [message('owner:1', 'other', 'Mason', 'Ship the wall today.')] },
  { session: session('RQ-A'), summary: ['RQ-A is a worker on claude.'], messages: [message('latest', 'session', 'RQ-A', 'Running the web suite now.')] },
  { session: session('RQ-B', { lane: 'codex', state: 'quiet' }), summary: ['RQ-B is a worker on codex.'], messages: [message('latest', 'session', 'RQ-B', 'Waiting on the build.')] },
];
type Counts = Record<string, number>;
/** GET /api/verse/fleet/control/session-threads; a narrowed read never lists the leader, as the route never does. */
function answer(scope: WallScope, counts: Counts = {}) {
  const narrowed = scope.lane !== null || scope.repo !== null || scope.live;
  const threads = SESSIONS.filter(({ session: s }) => (!narrowed || s.kind !== 'leader') && (!scope.lane || s.lane === scope.lane))
    .map(entry => ({ ...entry, messageCount: counts[entry.session.id] ?? 1, gaps: [] }));
  return { schema: 'fleet.session-threads.v1', generatedAt: AT, filter: scope, counts: { sessions: threads.length }, threads, gaps: [] };
}
/** GET /api/verse/fleet/control/session-thread?id=; the leader's ends in a reply box that writes to its inbox. */
const thread = (id: string) => ({ schema: 'fleet.session-thread.v1', generatedAt: AT, id, session: SESSIONS.find(entry => entry.session.id === id)!.session,
  summary: [`${id} summary.`], messages: [message('latest', 'session', id, `Latest from ${id}.`)], sources: {}, gaps: [],
  reply: id === 'leader' ? { to: 'leader', hint: 'Goes to the Leader inbox.' } : { to: 'job', job: id, mention: `@${id}`, hint: `Goes to the Leader inbox aimed at ${id}.` } });
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
function serve(counts: () => Counts = () => ({})) {
  const posted: { url: string; body: unknown }[] = [];
  const fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    if (init?.method === 'POST') { posted.push({ url: url.pathname, body: JSON.parse(String(init.body)) }); return json({ ok: true }); }
    if (url.pathname.endsWith('/session-thread')) return json(thread(url.searchParams.get('id')!));
    return json(answer({ lane: url.searchParams.get('lane'), repo: url.searchParams.get('repo'), live: url.searchParams.get('live') === '1' }, counts()));
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, posted };
}
const asked = (fetch: ReturnType<typeof serve>['fetch'], part: string) => fetch.mock.calls.map(call => String(call[0])).filter(url => url.includes(part));
const reread = () => act(() => refetchQuery(sessionWallQuery.key, () => sessionWallQuery.fetch(new AbortController().signal), true));
/** jsdom lays nothing out; this gives every element the pane's width, the way a real dock tab would. */
function paneWidth(width: number) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width, height: 700, top: 0, left: 0, right: width, bottom: 700, x: 0, y: 0, toJSON: () => ({}) });
}
const mount = () => render(<SessionWallPane visible host={{ openPane: vi.fn() } as never} />);
const dock = () => screen.queryByRole('complementary', { name: 'The Leader, beside the conversations' });
const leaderBox = () => within(dock()!).findByRole('textbox', { name: 'Message the Leader' });
const card = (id: string) => document.querySelector<HTMLButtonElement>(`button[data-card="${id}"]`)!;
const press = (key: string) => fireEvent.keyDown(document.activeElement!, { key });
const WIDE = WALL_LEADER_MIN_PX + 200;

beforeEach(() => { evictAll(); forgetWallSeen(); forgetWallView(); forgetWallLeader(); forgetThreadRead(); setMutationToken('a'.repeat(64)); takeRequestedWallSession(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); clearMutationToken(); });

describe('room for the Leader beside the conversations', () => {
  it('needs the first width beside the cards and the second beside an open conversation', () => {
    expect(leaderRoom(WALL_LEADER_MIN_PX - 1)).toBe(0);
    expect(leaderRoom(WALL_LEADER_MIN_PX)).toBe(1);
    expect(leaderRoom(OPEN_LEADER_MIN_PX - 1)).toBe(1);
    expect(leaderRoom(OPEN_LEADER_MIN_PX)).toBe(2);
  });

  it('names the leader from the read, and by the tree\'s own id when the read lists none', () => {
    expect(leaderIdOf([{ session: { id: 'RQ-A', kind: 'worker' } }, { session: { id: 'chief', kind: 'leader' } }])).toBe('chief');
    expect(leaderIdOf([{ session: { id: 'RQ-A', kind: 'worker' } }])).toBe(LEADER_SESSION_ID);
    expect(leaderIdOf(null)).toBe(LEADER_SESSION_ID);
  });

  it('keeps only that it was hidden, and reads anything else as shown', () => {
    expect(loadLeaderHidden()).toBe(false);
    expect(saveLeaderHidden(true)).toBe(true);
    expect(window.localStorage.getItem(WALL_LEADER_KEY)).toBe('hidden');
    expect(loadLeaderHidden()).toBe(true);
    expect(saveLeaderHidden(false)).toBe(true);
    expect(window.localStorage.getItem(WALL_LEADER_KEY)).toBeNull();
    window.localStorage.setItem(WALL_LEADER_KEY, 'yes');
    expect(loadLeaderHidden()).toBe(false);
    const denied = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('full'); }, removeItem: () => {} } as unknown as Storage;
    expect(loadLeaderHidden(denied)).toBe(false);
    expect(saveLeaderHidden(true, denied)).toBe(false);
    expect(saveLeaderHidden(true, null)).toBe(false);
  });
});

describe('the Leader beside the Conversations wall', () => {
  it('stays off a pane that has not been measured or is too narrow, where L opens the Leader\'s conversation ready to reply', async () => {
    const { fetch } = serve();
    mount();
    await screen.findByRole('list', { name: 'Conversations' });
    expect(dock()).toBeNull();
    expect(screen.queryByRole('button', { name: /Leader conversation/ })).toBeNull();
    expect(asked(fetch, '/session-thread?')).toEqual([]);
    card('RQ-A').focus();
    press('l');
    const box = await screen.findByRole('textbox', { name: 'Message the Leader' });
    await waitFor(() => expect(document.activeElement).toBe(box));
    expect(screen.getByRole('region').getAttribute('aria-label')).toBe('Session leader');
    expect(dock()).toBeNull();
  });

  it('shows the Leader\'s conversation beside the cards in a wide pane without taking the keyboard, and counts it as read', async () => {
    let counts: Counts = {};
    const { fetch } = serve(() => counts);
    paneWidth(WIDE);
    mount();
    await screen.findByRole('list', { name: 'Conversations' });
    expect(await within(dock()!).findByText('Latest from leader.')).toBeTruthy();
    expect(within(dock()!).getByRole('button', { name: 'Hide the Leader conversation' }).getAttribute('title')).toBe('Hide the Leader conversation (L brings it back)');
    // The cards are all still there, the leader's among them, and nothing took the keyboard.
    expect(card('leader')).toBeTruthy();
    expect(card('RQ-B')).toBeTruthy();
    expect(document.activeElement).toBe(document.body);
    expect(asked(fetch, '/session-thread?').every(url => url.endsWith('id=leader'))).toBe(true);
    // More messages everywhere: the worker's card is marked, the leader's is not, because its conversation is on screen.
    counts = { leader: 4, 'RQ-A': 3 };
    await reread();
    await waitFor(() => expect(within(card('RQ-A')).getByText('2 new')).toBeTruthy());
    expect(within(card('leader')).queryByText(/new$/)).toBeNull();
    expect(screen.getByRole('button', { name: /1 conversation has new messages/ })).toBeTruthy();
  });

  it('puts the cursor in the Leader\'s reply box on L, sends through the Leader\'s inbox, and gives the keyboard back on Esc', async () => {
    const { posted } = serve();
    paneWidth(WIDE);
    mount();
    await screen.findByRole('list', { name: 'Conversations' });
    card('RQ-A').focus();
    press('l');
    const box = await leaderBox();
    await waitFor(() => expect(document.activeElement).toBe(box));
    // L typed in the box is a letter, not the key.
    press('l');
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: 'Hold the release until the web suite is green.' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(posted).toEqual([{ url: INBOX, body: { source: 'Phantom desktop', text: 'Hold the release until the web suite is green.' } }]));
    expect(await within(dock()!).findByText('Hold the release until the web suite is green.')).toBeTruthy();
    // Esc leaves for the cards; the conversation stays where it is.
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(document.activeElement).toBe(card('leader'));
    expect(dock()).not.toBeNull();
    expect(loadLeaderHidden()).toBe(false);
    // An earlier L is not answered twice: back from an open conversation, the keyboard is on its card, not in the Leader's box.
    fireEvent.click(card('RQ-A'));
    fireEvent.keyDown(await screen.findByRole('region', { name: 'Session RQ-A' }), { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(card('RQ-A')));
    expect(dock()).not.toBeNull();
  });

  it('is put away by Hide, stays away across a reload, and comes back from its button or L', async () => {
    serve();
    paneWidth(WIDE);
    const first = mount();
    await screen.findByRole('list', { name: 'Conversations' });
    fireEvent.click(await within(dock()!).findByRole('button', { name: 'Hide the Leader conversation' }));
    expect(dock()).toBeNull();
    expect(window.localStorage.getItem(WALL_LEADER_KEY)).toBe('hidden');
    first.unmount();
    mount();
    await screen.findByRole('list', { name: 'Conversations' });
    expect(dock()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Leader conversation/ }));
    expect(dock()).not.toBeNull();
    expect(window.localStorage.getItem(WALL_LEADER_KEY)).toBeNull();
    expect(screen.queryByRole('button', { name: /^Leader conversation/ })).toBeNull();
    // Hidden again, L brings it back with the cursor in its reply box.
    fireEvent.click(await within(dock()!).findByRole('button', { name: 'Hide the Leader conversation' }));
    card('RQ-A').focus();
    press('l');
    const box = await leaderBox();
    await waitFor(() => expect(document.activeElement).toBe(box));
  });

  it('steps aside for an open conversation in a pane with room for two columns, and keeps the words typed to the Leader', async () => {
    serve();
    paneWidth(WIDE);
    mount();
    await screen.findByRole('list', { name: 'Conversations' });
    fireEvent.change(await leaderBox(), { target: { value: 'half a thought' } });
    fireEvent.click(card('RQ-A'));
    expect(await screen.findByText('Latest from RQ-A.')).toBeTruthy();
    // Off screen (the hidden attribute), not gone.
    expect(dock()).toBeNull();
    expect(screen.getAllByRole('region').map(region => region.getAttribute('aria-label'))).toEqual(['Session RQ-A']);
    fireEvent.keyDown(screen.getByRole('region', { name: 'Session RQ-A' }), { key: 'Escape' });
    await waitFor(() => expect(dock()).not.toBeNull());
    expect((await leaderBox() as HTMLTextAreaElement).value).toBe('half a thought');
    // With no room for a third column, L from an open conversation opens the Leader's own, ready to reply.
    fireEvent.click(card('RQ-B'));
    await screen.findByText('Latest from RQ-B.');
    fireEvent.keyDown(screen.getByRole('region', { name: 'Session RQ-B' }), { key: 'l' });
    const own = await screen.findByRole('region', { name: 'Session leader' });
    await waitFor(() => expect(document.activeElement).toBe(within(own).getByRole('textbox', { name: 'Message the Leader' })));
    expect(dock()).toBeNull();
  });

  it('stays beside an open conversation in a pane with room for three columns, except beside its own', async () => {
    serve();
    paneWidth(OPEN_LEADER_MIN_PX);
    mount();
    await screen.findByRole('list', { name: 'Conversations' });
    fireEvent.click(card('RQ-A'));
    expect(await screen.findByText('Latest from RQ-A.')).toBeTruthy();
    expect(dock()).not.toBeNull();
    expect(screen.getByRole('navigation', { name: 'Every session' })).toBeTruthy();
    // L writes to the Leader without closing what is open; Esc there goes back to the open conversation.
    press('l');
    const box = await leaderBox();
    await waitFor(() => expect(document.activeElement).toBe(box));
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Session RQ-A' }));
    // The Leader's own conversation, opened from the list, is never on screen twice.
    fireEvent.click(document.querySelector<HTMLButtonElement>('button[data-rail="leader"]')!);
    await screen.findByRole('region', { name: 'Session leader' });
    expect(dock()).toBeNull();
    expect(screen.getAllByText('Latest from leader.').length).toBeGreaterThan(0);
  });

  it('still reads the Leader while the wall is narrowed to a lane, which lists no leader', async () => {
    const { fetch } = serve();
    paneWidth(WIDE);
    mount();
    await screen.findByRole('list', { name: 'Conversations' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Lane' }), { target: { value: 'codex' } });
    await waitFor(() => expect(card('leader')).toBeNull());
    expect(card('RQ-B')).toBeTruthy();
    expect(await within(dock()!).findByText('Latest from leader.')).toBeTruthy();
    expect(asked(fetch, '/session-thread?').every(url => url.endsWith('id=leader'))).toBe(true);
    expect(NO_SCOPE.lane).toBeNull();
  });
});
