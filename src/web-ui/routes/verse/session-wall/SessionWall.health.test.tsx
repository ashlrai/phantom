import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { forgetThreadRead } from '../fleet-sessions/thread-read-store.js';
import { SessionWallPane } from './SessionWall.js';
import { forgetWallSeen } from './wall-seen.js';
import { takeRequestedWallSession } from './wall-selection.js';
import { forgetWallView } from './wall-view-store.js';
import { forgetWallLeader, OPEN_LEADER_MIN_PX, WALL_LEADER_MIN_PX } from './wall-leader.js';

const AT = '2026-11-20T12:00:00.000Z';
const HEALTH = '/api/verse/leader/health';
const session = (id: string, over: Record<string, unknown> = {}) => ({ id, kind: 'worker', agent: 'claude', lane: 'claude', model: 'fixture-model', repo: 'phantom',
  jobId: id, parentId: 'leader', state: 'running', lastMessageAgeSeconds: 120, prUrl: null, ...over });
const message = (key: string, side: string, label: string, text: string) => ({ key, kind: key.split(':')[0], side, label, at: null, text, format: 'plain' });
const SESSIONS = [
  { session: session('leader', { kind: 'leader', lane: 'unknown', model: 'unknown', repo: 'unknown', jobId: null, parentId: null, state: 'idle' }),
    summary: ['leader is the leader.'], messages: [message('owner:1', 'other', 'Mason', 'Ship the wall today.')] },
  { session: session('RQ-A'), summary: ['RQ-A is a worker on claude.'], messages: [message('latest', 'session', 'RQ-A', 'Running the web suite now.')] },
];
const wall = () => ({ schema: 'fleet.session-threads.v1', generatedAt: AT, filter: { lane: null, repo: null, live: false }, counts: { sessions: SESSIONS.length },
  threads: SESSIONS.map(entry => ({ ...entry, messageCount: 1, gaps: [] })), gaps: [] });
const thread = (id: string) => ({ schema: 'fleet.session-thread.v1', generatedAt: AT, id, session: SESSIONS.find(entry => entry.session.id === id)!.session,
  summary: [`${id} summary.`], messages: [message('latest', 'session', id, `Latest from ${id}.`)], sources: {}, gaps: [],
  reply: id === 'leader' ? { to: 'leader', hint: 'Goes to the Leader inbox.' } : { to: 'job', job: id, mention: `@${id}`, hint: `Goes to the Leader inbox aimed at ${id}.` } });
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** `health` is what GET /api/verse/leader/health answers; a function is asked each time, so a test can let the Leader recover. */
function serve(health: () => unknown) {
  const fetch = vi.fn(async (input: unknown) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === HEALTH) return json(health());
    if (url.pathname.endsWith('/session-thread')) return json(thread(url.searchParams.get('id')!));
    return json(wall());
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const failing = (failures = 3) => ({ schema: 'fleet.leader-health.v1', source: 'read', consecutiveFailures: failures, hoursSinceLastSuccess: 4.2,
  lastBetAt: null, cause: 'Claude sign-in expired: run claude login' });
const healthCalls = (fetch: ReturnType<typeof serve>) => fetch.mock.calls.filter(call => String(call[0]).split('?')[0] === HEALTH).length;
/** jsdom lays nothing out; this gives every element the pane's width, the way a real dock tab would. */
function paneWidth(width: number) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width, height: 700, top: 0, left: 0, right: width, bottom: 700, x: 0, y: 0, toJSON: () => ({}) });
}
const mount = () => render(<SessionWallPane visible host={{ openPane: vi.fn() } as never} />);
const card = (id: string) => document.querySelector<HTMLButtonElement>(`button[data-card="${id}"]`)!;
/** Every Leader health notice on screen (a hidden Leader conversation keeps its own, off screen). */
const notices = () => [...screen.queryAllByRole('alert'), ...screen.queryAllByRole('status')]
  .filter(node => node.getAttribute('aria-label') === 'Leader health' && node.closest('[hidden]') === null);
const dock = () => screen.queryByRole('complementary', { name: 'The Leader, beside the conversations' });

beforeEach(() => { evictAll(); forgetWallSeen(); forgetWallView(); forgetWallLeader(); forgetThreadRead(); takeRequestedWallSession(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Leader health on the Conversations wall', () => {
  it('says above the cards that the Leader is not reading, then above the reply box of the conversation that is opened', async () => {
    const fetch = serve(() => failing());
    mount();
    await screen.findByRole('list', { name: 'Conversations' });
    const top = await screen.findByRole('alert', { name: 'Leader health' });
    expect(top).toHaveAttribute('data-place', 'wall');
    expect(within(top).getByText('The Leader’s last 3 passes failed.')).toBeInTheDocument();
    expect(within(top).getByText('It is not reading you. What you send is kept in its inbox until a pass succeeds.')).toBeInTheDocument();
    expect(within(top).getByText('Claude sign-in expired: run claude login')).toBeInTheDocument();
    // Above the cards it speaks of.
    expect(top.compareDocumentPosition(card('RQ-A')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(card('RQ-A'));
    const box = await screen.findByRole('textbox', { name: 'Message RQ-A' });
    await waitFor(() => expect(notices()).toHaveLength(1));
    const [inThread] = notices();
    expect(inThread).toHaveAttribute('data-place', 'thread');
    expect(within(inThread!).getByText(/^A message to RQ-A goes through the Leader, and it is not reading you\./)).toBeInTheDocument();
    expect(inThread!.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Every copy reads the one cache entry.
    expect(healthCalls(fetch)).toBe(1);
  });

  it('is said once in a wide pane, above the reply box of the Leader conversation beside the cards', async () => {
    serve(() => failing());
    paneWidth(WALL_LEADER_MIN_PX + 200);
    mount();
    await screen.findByRole('list', { name: 'Conversations' });
    const box = await within(dock()!).findByRole('textbox', { name: 'Message the Leader' });
    await waitFor(() => expect(notices()).toHaveLength(1));
    const [beside] = notices();
    expect(dock()).toContainElement(beside!);
    expect(within(beside!).getByText('It is not reading you. What you send is kept in its inbox until a pass succeeds.')).toBeInTheDocument();
    expect(beside!.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Hidden, the Leader conversation takes its notice with it, so the wall says it above the cards.
    fireEvent.click(within(dock()!).getByRole('button', { name: 'Hide the Leader conversation' }));
    await waitFor(() => expect(notices().map(node => node.getAttribute('data-place'))).toEqual(['wall']));
  });

  it('stays with the Leader conversation while a session is open beside it in three columns', async () => {
    serve(() => failing(1));
    paneWidth(OPEN_LEADER_MIN_PX);
    mount();
    await screen.findByRole('list', { name: 'Conversations' });
    fireEvent.click(card('RQ-A'));
    await screen.findByRole('textbox', { name: 'Message RQ-A' });
    await within(dock()!).findByRole('textbox', { name: 'Message the Leader' });
    await waitFor(() => expect(notices()).toHaveLength(1));
    expect(notices()[0]).toHaveAttribute('data-state', 'failed');
    expect(dock()).toContainElement(notices()[0]!);
    expect(screen.getByRole('region', { name: 'Session RQ-A' })).not.toContainElement(notices()[0]!);
  });

  it('draws nothing while the Leader passes, or when the server has no such read', async () => {
    serve(() => failing(0));
    const healthy = mount();
    await screen.findByRole('list', { name: 'Conversations' });
    fireEvent.click(card('RQ-A'));
    await screen.findByRole('textbox', { name: 'Message RQ-A' });
    expect(notices()).toEqual([]);
    healthy.unmount();

    evictAll();
    // An older server answers the health path with something else: unknown, so nothing is claimed.
    serve(() => wall());
    mount();
    await screen.findByRole('list', { name: 'Conversations' });
    expect(notices()).toEqual([]);
  });
});
