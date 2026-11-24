import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { SESSION_THREAD_API } from '../fleet-sessions/session-thread-model.js';
import { LIVE_SESSIONS_API } from '../fleet-sessions/sessions-model.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import type { PaneHost } from '../panes/pane-registry.js';
import { takeRequestedWallSession } from '../session-wall/wall-selection.js';
import { takeLeaderDraft } from './leader-draft-store.js';
import { openConversationFromLeader } from './leader-reading.js';
import { rosterRows } from './leader-roster-model.js';
import { rosterFleet } from './leader-roster.test-support.js';
import { LeaderSurface } from './LeaderSurface.js';

/** The wall-clock string MASON-INBOX.md writes ("YYYY-MM-DD HH:MM" in America/New_York). */
const etWall = (ms: number) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(ms).replace(',', '');

const ORDER = 'ship the judge fix first';
const PR = 'https://github.com/ashlrai/phantom/pull/4321';

/** Any session as GET /api/verse/fleet/control/session-thread answers it (fleet.session-thread.v1), saying its own id. */
const conversation = (id: string) => ({
  schema: 'fleet.session-thread.v1', generatedAt: '2026-11-17T12:00:00.000Z', id,
  session: { id, kind: 'worker', agent: 'claude', lane: 'claude', model: 'fixture-model', repo: 'phantom', jobId: id, parentId: 'leader',
    state: 'running', startedAt: '2026-11-17T11:30:00.000Z', ageSeconds: 1800, lastMessageAt: '2026-11-17T11:58:00.000Z', lastMessageAgeSeconds: 120,
    prUrl: null, computer: 'node-here', helpers: { below: 0, running: 0, failed: 0 } },
  summary: [`Worker ${id} on claude.`],
  messages: [{ key: 'latest', kind: 'latest', side: 'session', label: 'Latest', at: '2026-11-17T11:58:00.000Z', text: `${id} is running the tests`, format: 'plain' }],
  sources: { sessions: 'available', activity: 'available', bus: 'none', owner: 'none', replies: 'none', orders: 'none' },
  gaps: [],
  reply: { to: 'job', job: id, mention: `@${id}`, hint: `Goes to the Leader inbox aimed at ${id}.` },
});

/** A Leader pane whose newest message from Mason was routed to one finished job and one still running. */
function serve() {
  const at = etWall(Date.now() - 10 * 60_000);
  return stubSurfaceFetch({ routes: {
    [LIVE_SESSIONS_API]: rosterFleet(),
    [SESSION_THREAD_API]: (url: string) => new Response(JSON.stringify(conversation(new URL(url, 'http://console.test').searchParams.get('id') ?? 'unknown')),
      { status: 200, headers: { 'Content-Type': 'application/json' } }),
    '/api/verse/leader/thread': { messages: [msg({ id: 'one', text: 'Hello from the Leader.' })] },
    '/api/verse/leader/directives': { directives: [] },
    '/api/verse/fleet/runs': {
      v: 1, generatedAt: new Date().toISOString(),
      sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'missing', merges: 'healthy' },
      lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
      host: null, lanes: [], workers: [], claimed: [], leaders: [], orchestratorAgents: null,
      publishesLastHour: [], mergesLastHour: { count: null, items: [] }, events: [], codexPersonal: null,
      inbox: [{ at, source: 'Phantom desktop', text: ORDER }], outbox: [], drop: null,
    },
    '/api/verse/leader/orders': {
      v: 1, generatedAt: new Date().toISOString(), sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' },
      orders: [{ at, source: 'Phantom desktop', key: at.slice(5), jobs: [
        { id: 'RQ-PHX-DONE', lane: 'devin', state: 'merged', url: PR },
        { id: 'RQ-A', lane: 'claude', state: 'launched', url: null },
      ] }],
    },
  } });
}

const host = () => ({ openPane: vi.fn(), sendToChat: vi.fn(), addToMessage: vi.fn() }) as unknown as PaneHost;

/** jsdom lays nothing out; this gives every element the pane's width, the way a real dock tab would. */
function paneWidth(width: number) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width, height: 600, top: 0, left: 0, right: width, bottom: 600, x: 0, y: 0, toJSON: () => ({}) });
}

beforeEach(() => { evictAll(); clearMutationToken(); window.localStorage.clear(); takeLeaderDraft(); takeRequestedWallSession(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); takeRequestedWallSession(); });

describe('a session named in the Leader chat', () => {
  it('opens beside the chat from a routed job, marks the row, and gives the keyboard back on close', async () => {
    paneWidth(1280);
    const net = serve();
    const paneHost = host();
    render(<LeaderSurface visible host={paneHost} />);
    const trail = await screen.findByRole('group', { name: /^Routing: 2 jobs/ });
    const [done, running] = within(trail).getAllByRole('listitem');
    const door = within(done!).getByRole('button', { name: 'Open conversation with RQ-PHX-DONE' });
    expect(door).toHaveTextContent('Conversation');
    expect(door).not.toHaveAttribute('aria-current');

    door.focus();
    fireEvent.click(door);
    const opened = screen.getByRole('region', { name: 'Session RQ-PHX-DONE' });
    expect(await within(opened).findByText('RQ-PHX-DONE is running the tests')).toBeInTheDocument();
    expect(opened.closest('[data-layout]')).toHaveAttribute('data-layout', 'beside');
    // It stayed in this pane: no other pane was opened and nothing was handed to Conversations.
    expect(paneHost.openPane).not.toHaveBeenCalled();
    expect(takeRequestedWallSession()).toBeNull();
    // The chat is still there, and the row says which session is open.
    expect(screen.getByText(ORDER).closest('[hidden]')).toBeNull();
    expect(door).toHaveAttribute('aria-current', 'true');
    expect(door).toHaveTextContent('Conversation open');
    expect(done).toHaveAttribute('data-reading', 'true');
    expect(running).not.toHaveAttribute('data-reading');
    // A finished job is not one of the working sessions, and the stepper says so.
    const working = rosterRows(rosterFleet()).length;
    await waitFor(() => expect(within(screen.getByRole('navigation', { name: 'Working sessions' })).getByRole('status'))
      .toHaveTextContent(`Not working now · ${working} working`));

    // The other routed job swaps it in place, and the strip marks the same session.
    fireEvent.click(within(running!).getByRole('button', { name: 'Open conversation with RQ-A' }));
    expect(screen.queryByRole('region', { name: 'Session RQ-PHX-DONE' })).toBeNull();
    const swapped = screen.getByRole('region', { name: 'Session RQ-A' });
    expect(done).not.toHaveAttribute('data-reading');
    expect(within(running!).getByRole('button', { name: 'Open conversation with RQ-A' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: 'Read RQ-A as a conversation' })).toHaveAttribute('aria-current', 'true');

    fireEvent.click(within(swapped).getByRole('button', { name: 'Close this conversation' }));
    expect(screen.queryByRole('region', { name: 'Session RQ-A' })).toBeNull();
    expect(within(running!).getByRole('button', { name: 'Open conversation with RQ-A' })).not.toHaveAttribute('aria-current');
    expect(net.posted).toEqual([]);
  });

  it('returns to the routed row that opened it, in a narrow pane too', async () => {
    paneWidth(640);
    serve();
    render(<LeaderSurface visible host={host()} />);
    const trail = await screen.findByRole('group', { name: /^Routing: 2 jobs/ });
    const door = within(trail).getByRole('button', { name: 'Open conversation with RQ-PHX-DONE' });
    door.focus();
    fireEvent.click(door);
    const opened = screen.getByRole('region', { name: 'Session RQ-PHX-DONE' });
    expect(opened.closest('[data-layout]')).toHaveAttribute('data-layout', 'over');
    expect(document.activeElement).toBe(opened);
    fireEvent.keyDown(opened, { key: 'Escape' });
    expect(screen.queryByRole('region', { name: 'Session RQ-PHX-DONE' })).toBeNull();
    // The covered chat may have drawn the row again; the button for that job has the keyboard either way.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open conversation with RQ-PHX-DONE' }));
  });

  it('/thread opens the session in this pane, and Esc returns to the reply box', async () => {
    paneWidth(1280);
    const net = serve();
    const paneHost = host();
    render(<LeaderSurface visible host={paneHost} />);
    await screen.findByText('Hello from the Leader.');
    const input = screen.getByRole('textbox', { name: 'Reply to the Leader' });
    input.focus();
    fireEvent.change(input, { target: { value: '/thread RQ-A' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    const opened = await screen.findByRole('region', { name: 'Session RQ-A' });
    const log = screen.getByRole('log', { name: 'Conversation with the Leader' });
    const answer = await within(log).findByText((_, element) => element?.tagName === 'P' && /^Opened the conversation with/.test(element.textContent ?? ''));
    expect(answer).toHaveTextContent(/^Opened the conversation with RQ-A \(running, claude\)\. Esc in it comes back here\./);
    // The session the answer names is the one open.
    expect(within(answer).getByRole('button', { name: 'Open the conversation with RQ-A' })).toHaveAttribute('aria-current', 'true');
    expect(paneHost.openPane).not.toHaveBeenCalled();
    expect(takeRequestedWallSession()).toBeNull();

    fireEvent.keyDown(opened, { key: 'Escape' });
    expect(screen.queryByRole('region', { name: 'Session RQ-A' })).toBeNull();
    expect(document.activeElement).toBe(input);
    expect(net.posted).toEqual([]);
  });

  it('hands the session to Conversations when no Leader pane is on screen', () => {
    expect(openConversationFromLeader('RQ-A')).toBe('conversations');
    expect(takeRequestedWallSession()).toBe('RQ-A');

    // A pane that has gone no longer takes requests.
    paneWidth(1280);
    serve();
    const view = render(<LeaderSurface visible host={host()} />);
    view.unmount();
    expect(openConversationFromLeader('RQ-B')).toBe('conversations');
    expect(takeRequestedWallSession()).toBe('RQ-B');
  });

  it('never opens free text as a session', () => {
    paneWidth(1280);
    serve();
    render(<LeaderSurface visible host={host()} />);
    expect(openConversationFromLeader('not a session id')).toBe('conversations');
    expect(screen.queryByRole('region', { name: /^Session / })).toBeNull();
    expect(takeRequestedWallSession()).toBeNull();
  });
});
