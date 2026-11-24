import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { takeRequestedWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { SESSION_THREAD_API } from '../fleet-sessions/session-thread-model.js';
import { LIVE_SESSIONS_API } from '../fleet-sessions/sessions-model.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { getPane, type PaneHost } from '../panes/pane-registry.js';
import { takeLeaderDraft } from './leader-draft-store.js';
import { LeaderRoster, ROSTER_OPEN_KEY } from './LeaderRoster.js';
import { LeaderSurface } from './LeaderSurface.js';
import { rosterEmpty, rosterFleet } from './leader-roster.test-support.js';
import './leader-thread.pane.js';

beforeEach(() => { evictAll(); window.localStorage.clear(); takeLeaderDraft(); takeRequestedWorkerLogJob(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** RQ-A as GET /api/verse/fleet/control/session-thread answers it (fleet.session-thread.v1). */
const conversation = () => ({
  schema: 'fleet.session-thread.v1', generatedAt: '2026-11-17T12:00:00.000Z', id: 'RQ-A',
  session: { id: 'RQ-A', kind: 'worker', agent: 'claude', lane: 'claude', model: 'fixture-model', repo: 'phantom', jobId: 'RQ-A', parentId: 'leader',
    state: 'running', startedAt: '2026-11-17T11:30:00.000Z', ageSeconds: 1800, lastMessageAt: '2026-11-17T11:58:00.000Z', lastMessageAgeSeconds: 120,
    prUrl: null, computer: 'node-here', helpers: { below: 0, running: 0, failed: 0 } },
  summary: ['Worker on claude, fixture-model, in phantom.'],
  messages: [
    { key: 'brief', kind: 'brief', side: 'other', label: 'Brief', at: null, text: 'Fix the flaky test.', format: 'plain' },
    { key: 'latest', kind: 'latest', side: 'session', label: 'Latest', at: '2026-11-17T11:58:00.000Z', text: 'Running the tests', format: 'plain' },
  ],
  sources: { sessions: 'available', activity: 'available', bus: 'none', owner: 'none', replies: 'none', orders: 'none' },
  gaps: [],
  reply: { to: 'job', mention: '@RQ-A', hint: 'Goes to the Leader inbox aimed at RQ-A.' },
});

const serve = (sessions: unknown) => stubSurfaceFetch({ routes: {
  [LIVE_SESSIONS_API]: sessions,
  [SESSION_THREAD_API]: conversation(),
  '/api/verse/leader/thread': { messages: [msg({ id: 'one', text: 'Hello from the Leader.' })] },
  '/api/verse/leader/directives': { directives: [] },
} });

function roster() {
  const onOpenLog = vi.fn(), onOpenSessions = vi.fn();
  render(<LeaderRoster visible onOpenLog={onOpenLog} onOpenSessions={onOpenSessions} />);
  return { onOpenLog, onOpenSessions, strip: screen.getByRole('region', { name: 'Working now' }) };
}

describe('Working now', () => {
  it('shows every running session with when it spoke and what it said, the quiet one first', async () => {
    serve(rosterFleet());
    const { strip } = roster();
    const list = await within(strip).findByRole('list', { name: 'Running agent sessions' });
    const lines = within(list).getAllByRole('listitem');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toHaveTextContent('RQ-QUIET');
    expect(lines[0]).toHaveTextContent('quiet 14m');
    expect(lines[0]).toHaveTextContent('Last message unknown');
    expect(within(list).getByText('Running the tests')).toBeInTheDocument();
    expect(within(strip).getByText('4 working now · 1 quiet')).toBeInTheDocument();
    expect(within(list).queryByText('RQ-FAILED')).toBeNull();
  });

  it('aiming puts the job in the Leader draft and says nothing was sent', async () => {
    const net = serve(rosterFleet());
    const { strip } = roster();
    fireEvent.click(await within(strip).findByRole('button', { name: /^Aim your next message at RQ-A,/ }));
    expect(takeLeaderDraft()).toBe('@RQ-A ');
    expect(within(strip).getByText('@RQ-A is in the reply box. Nothing is sent until you send it.')).toBeInTheDocument();
    expect(net.posted).toEqual([]);
  });

  it('a helper the steer syntax cannot name is listed but offers no aim', async () => {
    serve(rosterFleet());
    const { strip } = roster();
    await within(strip).findByText('helper-a');
    expect(within(strip).queryByRole('button', { name: /^Aim your next message at helper-a/ })).toBeNull();
    expect(within(strip).getByText('helper')).toBeInTheDocument();
  });

  it('Log, the L key and the PR link reach the job; All sessions opens the full list', async () => {
    serve(rosterFleet());
    const { strip, onOpenLog, onOpenSessions } = roster();
    fireEvent.click(await within(strip).findByRole('button', { name: 'Open the log for RQ-PR' }));
    expect(onOpenLog).toHaveBeenLastCalledWith('RQ-PR');
    fireEvent.keyDown(within(strip).getByRole('button', { name: /^Aim your next message at RQ-A,/ }), { key: 'l' });
    expect(onOpenLog).toHaveBeenLastCalledWith('RQ-A');
    expect(within(strip).getByRole('link', { name: 'PR' })).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/pull/9');
    fireEvent.click(within(strip).getByRole('button', { name: 'All sessions' }));
    expect(onOpenSessions).toHaveBeenCalledTimes(1);
  });

  it('Thread and the T key ask for that session as a conversation, only when the pane can show one', async () => {
    serve(rosterFleet());
    const onOpenThread = vi.fn();
    render(<LeaderRoster visible onOpenLog={vi.fn()} onOpenSessions={vi.fn()} onOpenThread={onOpenThread} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Read RQ-PR as a conversation' }));
    expect(onOpenThread).toHaveBeenLastCalledWith('RQ-PR');
    // A helper has no job to aim at, but its conversation can still be read.
    fireEvent.keyDown(screen.getByText('helper-a').closest('[data-roster-row]')!, { key: 't' });
    expect(onOpenThread).toHaveBeenLastCalledWith('helper-a');
    cleanup();
    const { strip } = roster();
    await within(strip).findByRole('list', { name: 'Running agent sessions' });
    expect(within(strip).queryByRole('button', { name: /as a conversation$/ })).toBeNull();
    fireEvent.keyDown(within(strip).getByRole('button', { name: /^Aim your next message at RQ-A,/ }), { key: 't' });
    expect(onOpenThread).toHaveBeenCalledTimes(2);
  });

  it('J and K move between lines, wrapping', async () => {
    serve(rosterFleet());
    const { strip } = roster();
    const list = await within(strip).findByRole('list', { name: 'Running agent sessions' });
    const lines = [...list.querySelectorAll<HTMLElement>('[data-roster-row]')];
    lines[0]!.focus();
    fireEvent.keyDown(lines[0]!, { key: 'j' });
    expect(document.activeElement).toBe(lines[1]);
    fireEvent.keyDown(lines[1]!, { key: 'ArrowUp' });
    fireEvent.keyDown(lines[0]!, { key: 'k' });
    expect(document.activeElement).toBe(lines[lines.length - 1]);
  });

  it('folds to its count line and remembers that', async () => {
    serve(rosterFleet());
    const { strip } = roster();
    await within(strip).findByRole('list', { name: 'Running agent sessions' });
    const toggle = within(strip).getByRole('button', { name: 'Working now' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    expect(within(strip).queryByRole('list')).toBeNull();
    expect(within(strip).getByText('4 working now · 1 quiet')).toBeInTheDocument();
    expect(window.localStorage.getItem(ROSTER_OPEN_KEY)).toBe('0');
    cleanup();
    expect(within(roster().strip).getByRole('button', { name: 'Working now' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('nobody working is its own line, with no list', async () => {
    serve(rosterEmpty());
    const { strip } = roster();
    expect(await within(strip).findByText('No agents are working right now')).toBeInTheDocument();
    expect(within(strip).queryByRole('list')).toBeNull();
  });

  it('a read that does not answer says unavailable, never that nobody is working', async () => {
    serve(null);
    const { strip } = roster();
    expect(within(strip).getByText('Reading sessions…')).toBeInTheDocument();
    expect(await within(strip).findByText(/^Sessions unavailable right now/)).toBeInTheDocument();
    expect(within(strip).queryByText(/No agents are working/)).toBeNull();
  });

  it('a body that is not a sessions list is unavailable too', async () => {
    serve({ schema: 'something.else' });
    const { strip } = roster();
    expect(await within(strip).findByText(/^Sessions unavailable right now/)).toBeInTheDocument();
  });
});

describe('Leader surface', () => {
  const host = () => ({ openPane: vi.fn(), sendToChat: vi.fn(), addToMessage: vi.fn() }) as unknown as PaneHost & { openPane: ReturnType<typeof vi.fn> };

  it('is what the Leader pane mounts', () => {
    expect(getPane('leader-thread')).toMatchObject({ id: 'leader-thread', title: 'Leader', needsSession: false });
  });

  it('aiming from the strip lands in the reply box, focused and unsent', async () => {
    const net = serve(rosterFleet());
    render(<LeaderSurface visible host={host()} />);
    await screen.findByText('Hello from the Leader.');
    const input = screen.getByRole('textbox', { name: 'Reply to the Leader' });
    fireEvent.change(input, { target: { value: 'please rebase' } });
    fireEvent.click(await screen.findByRole('button', { name: /^Aim your next message at RQ-QUIET,/ }));
    await waitFor(() => expect(input).toHaveValue('please rebase\n\n@RQ-QUIET '));
    expect(document.activeElement).toBe(input);
    expect(net.posted).toEqual([]);
  });

  it('Thread opens the session as a conversation in the pane and Esc returns to the chat with the draft kept', async () => {
    const net = serve(rosterFleet());
    render(<LeaderSurface visible host={host()} />);
    await screen.findByText('Hello from the Leader.');
    const input = screen.getByRole('textbox', { name: 'Reply to the Leader' });
    fireEvent.change(input, { target: { value: 'half a thought' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Read RQ-A as a conversation' }));

    const opened = screen.getByRole('region', { name: 'Session RQ-A' });
    expect(document.activeElement).toBe(opened);
    const log = await within(opened).findByRole('list', { name: 'Conversation with RQ-A' });
    expect(within(log).getByText('Running the tests')).toBeInTheDocument();
    expect(within(opened).getByLabelText('Summary')).toHaveTextContent('Worker on claude, fixture-model, in phantom.');
    expect(net.fetchMock.mock.calls.map(call => String(call[0]))).toContain(`${SESSION_THREAD_API}?id=RQ-A`);
    // The reply box is the session's own, and the chat underneath is out of reach, not gone.
    expect(within(opened).getByRole('textbox', { name: 'Message RQ-A' })).toBeInTheDocument();
    expect(within(opened).getByText('Goes to the Leader inbox aimed at RQ-A.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Working now' })).toBeNull();
    expect(input.closest('[hidden]')).not.toBeNull();

    fireEvent.keyDown(opened, { key: 'Escape' });
    expect(screen.queryByRole('region', { name: 'Session RQ-A' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Reply to the Leader' })).toHaveValue('half a thought');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Read RQ-A as a conversation' }));

    // Back is named for where it goes from here, and Live log still reaches the job.
    const paneHost = host();
    cleanup();
    render(<LeaderSurface visible host={paneHost} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Read RQ-A as a conversation' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Live log' }));
    expect(takeRequestedWorkerLogJob()).toBe('RQ-A');
    expect(paneHost.openPane).toHaveBeenLastCalledWith('worker-log');
    fireEvent.click(screen.getByRole('button', { name: 'Back to the Leader chat' }));
    expect(screen.getByRole('region', { name: 'Working now' })).toBeInTheDocument();
    expect(net.posted).toEqual([]);
  });

  it('Log opens that job in the Worker log; All sessions opens the Sessions pane', async () => {
    serve(rosterFleet());
    const paneHost = host();
    render(<LeaderSurface visible host={paneHost} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open the log for RQ-A' }));
    expect(takeRequestedWorkerLogJob()).toBe('RQ-A');
    expect(paneHost.openPane).toHaveBeenLastCalledWith('worker-log');
    fireEvent.click(screen.getByRole('button', { name: 'All sessions' }));
    expect(paneHost.openPane).toHaveBeenLastCalledWith('fleet-sessions');
  });
});
