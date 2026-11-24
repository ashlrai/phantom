import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { takeRequestedWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { SESSION_THREAD_API } from '../fleet-sessions/session-thread-model.js';
import { LIVE_SESSIONS_API } from '../fleet-sessions/sessions-model.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import type { PaneHost } from '../panes/pane-registry.js';
import { takeLeaderDraft } from './leader-draft-store.js';
import { LeaderSurface } from './LeaderSurface.js';
import { rosterRows } from './leader-roster-model.js';
import { rosterFleet } from './leader-roster.test-support.js';
import { BESIDE_MIN_PX, fitsBeside, stepWords, threadStep } from './surface-layout.js';

beforeEach(() => { evictAll(); window.localStorage.clear(); takeLeaderDraft(); takeRequestedWorkerLogJob(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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

const serve = () => stubSurfaceFetch({ routes: {
  [LIVE_SESSIONS_API]: rosterFleet(),
  [SESSION_THREAD_API]: (url: string) => new Response(JSON.stringify(conversation(new URL(url, 'http://console.test').searchParams.get('id') ?? 'unknown')),
    { status: 200, headers: { 'Content-Type': 'application/json' } }),
  '/api/verse/leader/thread': { messages: [msg({ id: 'one', text: 'Hello from the Leader.' })] },
  '/api/verse/leader/directives': { directives: [] },
} });

const host = () => ({ openPane: vi.fn(), sendToChat: vi.fn(), addToMessage: vi.fn() }) as unknown as PaneHost;

/** jsdom lays nothing out; this gives every element the pane's width, the way a real dock tab would. */
function paneWidth(width: number) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width, height: 600, top: 0, left: 0, right: width, bottom: 600, x: 0, y: 0, toJSON: () => ({}) });
}

/** The working sessions in the order the strip lists them. */
const working = () => rosterRows(rosterFleet()).map(row => row.session);

describe('surface layout', () => {
  it('puts two conversations side by side only from the minimum width up', () => {
    expect(fitsBeside(BESIDE_MIN_PX - 1)).toBe(false);
    expect(fitsBeside(BESIDE_MIN_PX)).toBe(true);
  });

  it('steps round the working sessions and says where the open one stands', () => {
    const list = ['RQ-1', 'RQ-2', 'RQ-3'];
    expect(threadStep(list, 'RQ-1', 1)).toBe('RQ-2');
    expect(threadStep(list, 'RQ-1', -1)).toBe('RQ-3');
    expect(threadStep(list, 'RQ-3', 1)).toBe('RQ-1');
    expect(stepWords(list, 'RQ-2')).toBe('2 of 3 working');
    // A session that finished while open: forward is the first, back the last, and the words do not count it.
    expect(threadStep(list, 'RQ-GONE', 1)).toBe('RQ-1');
    expect(threadStep(list, 'RQ-GONE', -1)).toBe('RQ-3');
    expect(stepWords(list, 'RQ-GONE')).toBe('Not working now · 3 working');
    // Nowhere to go: alone in the list, or nobody working.
    expect(threadStep(['RQ-1'], 'RQ-1', 1)).toBeNull();
    expect(threadStep([], 'RQ-1', -1)).toBeNull();
    expect(stepWords([], 'RQ-1')).toBe('Not working now · nobody else is');
    // A list that has not answered is unknown, never "nobody".
    expect(stepWords(null, 'RQ-1')).toBe('Working sessions unknown');
  });
});

describe('a session beside the Leader chat', () => {
  it('opens beside the chat in a wide pane, with both reply boxes and the strip still on screen', async () => {
    paneWidth(1280);
    const net = serve();
    render(<LeaderSurface visible host={host()} />);
    await screen.findByText('Hello from the Leader.');
    const leaderBox = screen.getByRole('textbox', { name: 'Reply to the Leader' });
    fireEvent.change(leaderBox, { target: { value: 'half a thought' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Read RQ-A as a conversation' }));

    const opened = screen.getByRole('region', { name: 'Session RQ-A' });
    expect(await within(opened).findByText('RQ-A is running the tests')).toBeInTheDocument();
    expect(within(opened).getByRole('textbox', { name: 'Message RQ-A' })).toBeInTheDocument();
    // The chat is not covered: its box keeps the draft, the strip is there and marks the open line.
    expect(leaderBox.closest('[hidden]')).toBeNull();
    expect(leaderBox).toHaveValue('half a thought');
    expect(screen.getByRole('region', { name: 'Working now' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Read RQ-A as a conversation' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: 'Read RQ-PR as a conversation' })).not.toHaveAttribute('aria-current');
    expect(opened.closest('[data-layout]')).toHaveAttribute('data-layout', 'beside');

    // Another line swaps the conversation in place; nothing typed for RQ-A follows it there.
    fireEvent.change(within(opened).getByRole('textbox', { name: 'Message RQ-A' }), { target: { value: 'for A only' } });
    fireEvent.click(screen.getByRole('button', { name: 'Read RQ-PR as a conversation' }));
    const swapped = screen.getByRole('region', { name: 'Session RQ-PR' });
    expect(screen.queryByRole('region', { name: 'Session RQ-A' })).toBeNull();
    expect(await within(swapped).findByRole('textbox', { name: 'Message RQ-PR' })).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Read RQ-PR as a conversation' })).toHaveAttribute('aria-current', 'true');

    // Close is named for what it does here, and the line gets the keyboard back.
    fireEvent.click(within(swapped).getByRole('button', { name: 'Close this conversation' }));
    expect(screen.queryByRole('region', { name: 'Session RQ-PR' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Read RQ-PR as a conversation' }));
    expect(screen.getByRole('textbox', { name: 'Reply to the Leader' })).toHaveValue('half a thought');
    expect(net.posted).toEqual([]);
  });

  it('covers the chat in a narrow pane, as before', async () => {
    paneWidth(640);
    serve();
    render(<LeaderSurface visible host={host()} />);
    await screen.findByText('Hello from the Leader.');
    fireEvent.click(await screen.findByRole('button', { name: 'Read RQ-A as a conversation' }));
    const opened = screen.getByRole('region', { name: 'Session RQ-A' });
    expect(opened.closest('[data-layout]')).toHaveAttribute('data-layout', 'over');
    expect(screen.queryByRole('region', { name: 'Working now' })).toBeNull();
    expect(within(opened).getByRole('button', { name: 'Back to the Leader chat' })).toBeInTheDocument();
  });

  it('steps to the next and previous working session with ] and [, but not from a text field', async () => {
    paneWidth(640);
    serve();
    const order = working();
    const first = order[0]!, second = order[1]!, last = order[order.length - 1]!;
    render(<LeaderSurface visible host={host()} />);
    await screen.findByText('Hello from the Leader.');
    fireEvent.click(await screen.findByRole('button', { name: `Read ${first} as a conversation` }));
    const stepper = screen.getByRole('navigation', { name: 'Working sessions' });
    await waitFor(() => expect(within(stepper).getByRole('status')).toHaveTextContent(`1 of ${order.length} working`));

    fireEvent.keyDown(screen.getByRole('region', { name: `Session ${first}` }), { key: ']' });
    const next = screen.getByRole('region', { name: `Session ${second}` });
    expect(document.activeElement).toBe(next);
    expect(within(stepper).getByRole('status')).toHaveTextContent(`2 of ${order.length} working`);

    // A bracket typed into the reply box is text.
    const box = await within(next).findByRole('textbox');
    fireEvent.keyDown(box, { key: '[' });
    expect(screen.getByRole('region', { name: `Session ${second}` })).toBeInTheDocument();

    fireEvent.keyDown(next, { key: '[' });
    fireEvent.click(within(stepper).getByRole('button', { name: 'Previous working session' }));
    expect(screen.getByRole('region', { name: `Session ${last}` })).toBeInTheDocument();
    fireEvent.click(within(stepper).getByRole('button', { name: 'Next working session' }));
    expect(screen.getByRole('region', { name: `Session ${first}` })).toBeInTheDocument();
  });
});
