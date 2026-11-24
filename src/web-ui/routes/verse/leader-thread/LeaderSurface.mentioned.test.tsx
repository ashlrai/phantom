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
import { rosterFleet } from './leader-roster.test-support.js';
import { LeaderSurface } from './LeaderSurface.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';

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

const SAID = 'Launched RQ-A and RQ-QUIET. RQ-FAILED stopped, RQ-GONE is older. See #42.';

/** A Leader message naming four jobs and a pull request; `sessions` is the session list's answer (null: the route is absent). */
function serve(sessions: unknown) {
  return stubSurfaceFetch({ routes: {
    [LIVE_SESSIONS_API]: sessions,
    [SESSION_THREAD_API]: (url: string) => new Response(JSON.stringify(conversation(new URL(url, 'http://console.test').searchParams.get('id') ?? 'unknown')),
      { status: 200, headers: { 'Content-Type': 'application/json' } }),
    '/api/verse/leader/thread': { messages: [msg({ id: 'one', text: SAID })] },
    '/api/verse/leader/directives': { directives: [] },
    '/api/verse/fleet/runs': { inbox: [] },
  } });
}

const host = () => ({ openPane: vi.fn(), sendToChat: vi.fn(), addToMessage: vi.fn() }) as unknown as PaneHost;

/** jsdom lays nothing out; this gives every element the pane's width, the way a real dock tab would. */
function paneWidth(width: number) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width, height: 600, top: 0, left: 0, right: width, bottom: 600, x: 0, y: 0, toJSON: () => ({}) });
}

/** How many times the session list was asked for. */
const listReads = (net: { fetchMock: { mock: { calls: unknown[][] } } }) => net.fetchMock.mock.calls.filter(([input]) => String(input).startsWith(LIVE_SESSIONS_API)).length;
const chip = (list: HTMLElement, job: string) => within(list).getByRole('button', { name: `Open the conversation with ${job}` }).closest('li')!;

beforeEach(() => { evictAll(); clearMutationToken(); window.localStorage.clear(); takeLeaderDraft(); takeRequestedWallSession(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); takeRequestedWallSession(); });

describe('jobs named in a Leader message', () => {
  it('say what each session is doing now, from the session list', async () => {
    paneWidth(1280);
    const net = serve(rosterFleet());
    render(<LeaderSurface visible host={host()} />);
    const list = await screen.findByRole('list', { name: 'Sessions named in this message' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(4);

    await waitFor(() => expect(chip(list, 'RQ-A')).toHaveAttribute('data-state', 'running'));
    expect(chip(list, 'RQ-A')).toHaveTextContent('running · claude · spoke 2m ago');
    expect(within(chip(list, 'RQ-A')).getByText('Running the tests')).toHaveAttribute('title', 'Running the tests');
    expect(chip(list, 'RQ-QUIET')).toHaveAttribute('data-state', 'quiet');
    expect(chip(list, 'RQ-QUIET')).toHaveTextContent('quiet 14m · claude');
    expect(chip(list, 'RQ-FAILED')).toHaveAttribute('data-state', 'failed');
    expect(chip(list, 'RQ-FAILED')).toHaveTextContent('failed · claude');
    // A job the list does not hold is not called finished.
    expect(chip(list, 'RQ-GONE')).toHaveAttribute('data-state', 'absent');
    expect(chip(list, 'RQ-GONE')).toHaveTextContent('not in the session list');

    // The pull request is still a link, on its own line.
    const row = screen.getByLabelText('Mentioned');
    expect(row).toHaveTextContent('Pull requests: #42');
    expect(within(row).getByRole('link', { name: '#42' })).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/pull/42');
    // The strip and the chips share one read of the list.
    expect(listReads(net)).toBe(1);
  });

  it('open beside the chat from the job id, and the keyboard comes back to it', async () => {
    paneWidth(1280);
    const net = serve(rosterFleet());
    const paneHost = host();
    render(<LeaderSurface visible host={paneHost} />);
    const list = await screen.findByRole('list', { name: 'Sessions named in this message' });
    const door = within(list).getByRole('button', { name: 'Open the conversation with RQ-QUIET' });
    expect(door).not.toHaveAttribute('aria-current');

    door.focus();
    fireEvent.click(door);
    const opened = screen.getByRole('region', { name: 'Session RQ-QUIET' });
    expect(await within(opened).findByText('RQ-QUIET is running the tests')).toBeInTheDocument();
    expect(opened.closest('[data-layout]')).toHaveAttribute('data-layout', 'beside');
    expect(paneHost.openPane).not.toHaveBeenCalled();
    expect(takeRequestedWallSession()).toBeNull();
    expect(door).toHaveAttribute('aria-current', 'true');
    expect(chip(list, 'RQ-QUIET')).toHaveAttribute('data-open', 'true');
    expect(chip(list, 'RQ-A')).not.toHaveAttribute('data-open');

    fireEvent.click(within(opened).getByRole('button', { name: 'Close this conversation' }));
    expect(screen.queryByRole('region', { name: 'Session RQ-QUIET' })).toBeNull();
    expect(door).not.toHaveAttribute('aria-current');
    expect(door).toHaveFocus();

    // Log still opens the worker log.
    fireEvent.click(within(list).getByRole('button', { name: 'Open log for RQ-FAILED' }));
    expect(paneHost.openPane).not.toHaveBeenCalledWith('session-wall');
    expect(net.posted).toEqual([]);
  });

  it('read "state unknown" when the session list cannot be read, and still open', async () => {
    serve(null);
    render(<LeaderThreadPane visible />);
    const list = await screen.findByRole('list', { name: 'Sessions named in this message' });
    await waitFor(() => expect(chip(list, 'RQ-A')).toHaveAttribute('data-state', 'unread'));
    for (const job of ['RQ-A', 'RQ-QUIET', 'RQ-FAILED', 'RQ-GONE']) {
      expect(chip(list, job)).toHaveTextContent('state unknown');
      expect(chip(list, job)).not.toHaveTextContent(/running|finished|failed|idle/);
    }
    // With no Leader surface mounted the session opens in Conversations, as the routed rows do.
    fireEvent.click(within(list).getByRole('button', { name: 'Open the conversation with RQ-A' }));
    expect(takeRequestedWallSession()).toBe('RQ-A');
  });

  it('keep the plain "Mentioned" line for a message that names only pull requests', async () => {
    const net = stubSurfaceFetch({ routes: {
      '/api/verse/leader/thread': { messages: [msg({ id: 'one', text: 'Merged acme/app#7.' })] },
      '/api/verse/leader/directives': { directives: [] },
      '/api/verse/fleet/runs': { inbox: [] },
    } });
    render(<LeaderThreadPane visible />);
    const row = await screen.findByLabelText('Mentioned');
    expect(row).toHaveTextContent('Mentioned: acme/app #7');
    expect(within(row).queryByRole('list')).toBeNull();
    // No job named, so the session list is not asked for.
    expect(listReads(net)).toBe(0);
  });
});
