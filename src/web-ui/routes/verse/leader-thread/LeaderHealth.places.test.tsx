import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { SESSION_THREAD_API } from '../fleet-sessions/session-thread-model.js';
import { SessionThread } from '../fleet-sessions/SessionThread.js';
import { LIVE_SESSIONS_API } from '../fleet-sessions/sessions-model.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import type { PaneHost } from '../panes/pane-registry.js';
import { LeaderSurface } from './LeaderSurface.js';
import { rosterFleet } from './leader-roster.test-support.js';

const HEALTH = '/api/verse/leader/health';
const failing = (over: Record<string, unknown> = {}) => ({
  schema: 'fleet.leader-health.v1', source: 'read', consecutiveFailures: 3, hoursSinceLastSuccess: 4.2,
  lastBetAt: null, cause: 'Claude sign-in expired: run claude login', ...over,
});

type Reply = { to: 'job'; job: string; mention: string; hint: string } | { to: 'leader' | 'none'; hint: string };
/** A session as GET /api/verse/fleet/control/session-thread answers it; the Leader's reply box writes to its inbox, a worker's is aimed. */
function conversation(id: string, reply?: Reply) {
  const leader = id === 'leader';
  return {
    schema: 'fleet.session-thread.v1', generatedAt: '2026-11-17T12:00:00.000Z', id,
    session: { id, kind: leader ? 'leader' : 'worker', agent: 'claude', lane: 'claude', model: 'fixture-model', repo: 'phantom', jobId: leader ? null : id,
      parentId: leader ? null : 'leader', state: 'running', startedAt: '2026-11-17T11:30:00.000Z', ageSeconds: 1800, lastMessageAt: '2026-11-17T11:58:00.000Z',
      lastMessageAgeSeconds: 120, prUrl: null, computer: 'node-here', helpers: { below: 0, running: 0, failed: 0 } },
    summary: [`${id} summary.`],
    messages: [{ key: 'latest', kind: 'latest', side: 'session', label: 'Latest', at: '2026-11-17T11:58:00.000Z', text: `Latest from ${id}.`, format: 'plain' }],
    sources: { sessions: 'available', activity: 'available', bus: 'none', owner: 'none', replies: 'none', orders: 'none' }, gaps: [],
    reply: reply ?? (leader ? { to: 'leader', hint: 'Goes to the Leader inbox.' } : { to: 'job', job: id, mention: `@${id}`, hint: `Goes to the Leader inbox aimed at ${id}.` }),
  };
}

function serve(health: unknown, reply?: Reply) {
  return stubSurfaceFetch({ routes: {
    [LIVE_SESSIONS_API]: rosterFleet(),
    [SESSION_THREAD_API]: (url: string) => new Response(JSON.stringify(conversation(new URL(url, 'http://console.test').searchParams.get('id') ?? 'unknown', reply)),
      { status: 200, headers: { 'Content-Type': 'application/json' } }),
    '/api/verse/leader/thread': { messages: [msg({ id: 'one', text: 'Hello from the Leader.' })] },
    '/api/verse/leader/directives': { directives: [] },
    [HEALTH]: health,
  } });
}
const healthCalls = (net: ReturnType<typeof serve>) => net.fetchMock.mock.calls.filter(call => String(call[0]).split('?')[0] === HEALTH).length;
const notices = () => [...screen.queryAllByRole('alert'), ...screen.queryAllByRole('status')].filter(node => node.getAttribute('aria-label') === 'Leader health');
const host = () => ({ openPane: vi.fn(), sendToChat: vi.fn(), addToMessage: vi.fn() }) as unknown as PaneHost;
/** jsdom lays nothing out; this gives every element the pane's width, the way a real dock tab would. */
function paneWidth(width: number) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width, height: 600, top: 0, left: 0, right: width, bottom: 600, x: 0, y: 0, toJSON: () => ({}) });
}

beforeEach(() => { evictAll(); window.localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Leader health above a session reply box', () => {
  it('says a message to a worker goes through a Leader that is not reading, just above the box it is typed in', async () => {
    serve(failing());
    render(<SessionThread id="RQ-A" visible onBack={() => {}} />);
    const notice = await screen.findByRole('alert', { name: 'Leader health' });
    expect(notice).toHaveAttribute('data-state', 'down');
    expect(notice).toHaveAttribute('data-place', 'thread');
    expect(within(notice).getByText('The Leader’s last 3 passes failed.')).toBeInTheDocument();
    expect(within(notice).getByText('A message to RQ-A goes through the Leader, and it is not reading you. What you send is kept in its inbox until a pass succeeds.')).toBeInTheDocument();
    expect(within(notice).getByText('Claude sign-in expired: run claude login')).toBeInTheDocument();
    const box = screen.getByRole('textbox', { name: 'Message RQ-A' });
    expect(notice.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Session RQ-A' })).toContainElement(notice);
  });

  it('warns after one failed pass, and in the Leader’s own conversation uses the Leader chat’s words', async () => {
    serve(failing({ consecutiveFailures: 1, hoursSinceLastSuccess: 0.5, cause: null }));
    const { unmount } = render(<SessionThread id="RQ-A" visible onBack={() => {}} />);
    const one = await screen.findByRole('status', { name: 'Leader health' });
    expect(one).toHaveAttribute('data-state', 'failed');
    expect(within(one).getByText('A message to RQ-A goes through the Leader. What you send is kept in its inbox; the next pass may read it.')).toBeInTheDocument();
    unmount();
    render(<SessionThread id="leader" visible onBack={() => {}} />);
    const own = await screen.findByRole('status', { name: 'Leader health' });
    expect(within(own).getByText('What you send is kept in its inbox; the next pass may read it.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message the Leader' })).toBeInTheDocument();
  });

  it('draws nothing for a healthy Leader, a read that is not the document, a session with no reply box, or where it is turned off', async () => {
    serve(failing({ consecutiveFailures: 0 }));
    const healthy = render(<SessionThread id="RQ-A" visible onBack={() => {}} />);
    await screen.findByRole('textbox', { name: 'Message RQ-A' });
    expect(notices()).toEqual([]);
    healthy.unmount();

    evictAll();
    serve({ ok: true });
    const unknown = render(<SessionThread id="RQ-A" visible onBack={() => {}} />);
    await screen.findByRole('textbox', { name: 'Message RQ-A' });
    expect(notices()).toEqual([]);
    unknown.unmount();

    evictAll();
    const net = serve(failing(), { to: 'none', hint: 'This session has finished; nothing is sent to it.' });
    const finished = render(<SessionThread id="RQ-A" visible onBack={() => {}} />);
    await screen.findByText('This session has finished; nothing is sent to it.');
    expect(notices()).toEqual([]);
    // With no box to write in, the reading is not asked for either.
    expect(healthCalls(net)).toBe(0);
    finished.unmount();

    evictAll();
    serve(failing());
    render(<SessionThread id="RQ-A" visible onBack={() => {}} leaderHealth={false} />);
    await screen.findByRole('textbox', { name: 'Message RQ-A' });
    expect(notices()).toEqual([]);
  });
});

describe('Leader health in the Leader pane with a session open', () => {
  it('is said once when the session sits beside the chat, from one request', async () => {
    paneWidth(1280);
    const net = serve(failing());
    render(<LeaderSurface visible host={host()} />);
    await screen.findByRole('alert', { name: 'Leader health' });
    fireEvent.click(await screen.findByRole('button', { name: 'Read RQ-A as a conversation' }));
    const opened = screen.getByRole('region', { name: 'Session RQ-A' });
    await within(opened).findByRole('textbox', { name: 'Message RQ-A' });
    expect(notices()).toHaveLength(1);
    expect(opened).not.toContainElement(notices()[0]!);
    expect(healthCalls(net)).toBe(1);
  });

  it('moves to the session’s reply box when the session covers the chat', async () => {
    const net = serve(failing());
    render(<LeaderSurface visible host={host()} />);
    await screen.findByRole('alert', { name: 'Leader health' });
    fireEvent.click(await screen.findByRole('button', { name: 'Read RQ-A as a conversation' }));
    const opened = screen.getByRole('region', { name: 'Session RQ-A' });
    const box = await within(opened).findByRole('textbox', { name: 'Message RQ-A' });
    const shown = within(opened).getByRole('alert', { name: 'Leader health' });
    expect(within(shown).getByText(/^A message to RQ-A goes through the Leader/)).toBeInTheDocument();
    expect(shown.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The chat underneath is hidden, so its notice is not on screen; both read the one cache entry.
    expect(notices().filter(node => node.closest('[hidden]') === null)).toEqual([shown]);
    expect(healthCalls(net)).toBe(1);
  });
});
