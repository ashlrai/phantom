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
import { awayFleet, type EndedFixture } from './catchup-sessions.test-support.js';
import { LEADER_LAST_LOOKED_KEY } from './leader-catchup-model.js';
import { takeLeaderDraft } from './leader-draft-store.js';
import { LeaderSurface } from './LeaderSurface.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';

const MIN = 60_000, HOUR = 60 * MIN;
const iso = (ms: number) => new Date(ms).toISOString();

/** Any session as GET /api/verse/fleet/control/session-thread answers it (fleet.session-thread.v1), saying its own id. */
const conversation = (id: string) => ({
  schema: 'fleet.session-thread.v1', generatedAt: iso(Date.now()), id,
  session: { id, kind: 'worker', agent: 'claude', lane: 'claude', model: 'fixture-model', repo: 'phantom', jobId: id, parentId: 'leader',
    state: 'failed', startedAt: iso(Date.now() - HOUR), ageSeconds: 3600, lastMessageAt: iso(Date.now() - 5 * MIN), lastMessageAgeSeconds: 300,
    prUrl: null, computer: 'node-here', helpers: { below: 0, running: 0, failed: 0 } },
  summary: [`Worker ${id} on claude.`],
  messages: [{ key: 'latest', kind: 'latest', side: 'session', label: 'Latest', at: iso(Date.now() - 5 * MIN), text: `${id} stopped on a failing test`, format: 'plain' }],
  sources: { sessions: 'available', activity: 'available', bus: 'none', owner: 'none', replies: 'none', orders: 'none' },
  gaps: [],
  reply: { to: 'none', job: null, mention: null, hint: 'This session has ended.' },
});

/** `sessions` is the session list's answer (null: the route is absent); `messages` is the Leader thread. */
function serve(sessions: unknown, messages: ReturnType<typeof msg>[] = []) {
  return stubSurfaceFetch({ routes: {
    [LIVE_SESSIONS_API]: sessions,
    [SESSION_THREAD_API]: (url: string) => new Response(JSON.stringify(conversation(new URL(url, 'http://console.test').searchParams.get('id') ?? 'unknown')),
      { status: 200, headers: { 'Content-Type': 'application/json' } }),
    '/api/verse/leader/thread': { messages },
    '/api/verse/leader/directives': { directives: [] },
    '/api/verse/fleet/runs': { inbox: [] },
  } });
}

const host = () => ({ openPane: vi.fn(), sendToChat: vi.fn(), addToMessage: vi.fn() }) as unknown as PaneHost;
/** jsdom lays nothing out; this gives every element the pane's width, the way a real dock tab would. */
function paneWidth(width: number) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width, height: 600, top: 0, left: 0, right: width, bottom: 600, x: 0, y: 0, toJSON: () => ({}) });
}
const lastLooked = (ms: number) => window.localStorage.setItem(LEADER_LAST_LOOKED_KEY, JSON.stringify(ms));
const card = () => screen.queryByRole('region', { name: 'Since you last looked' });
const ENDED = 'Sessions that ended while you were away';
const rowOf = (list: HTMLElement, job: string) => within(list).getByRole('button', { name: new RegExp(`^Open the conversation with ${job},`) }).closest('li')!;
const THREE: EndedFixture[] = [
  { job: 'RQ-PR', minutesAgo: 12, outcome: 'pr' },
  { job: 'RQ-FAILED', minutesAgo: 5, outcome: 'failed' },
  { job: 'RQ-BEFORE', minutesAgo: 50, outcome: 'empty' },
];

beforeEach(() => { evictAll(); clearMutationToken(); window.localStorage.clear(); takeLeaderDraft(); takeRequestedWallSession(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); takeRequestedWallSession(); });

describe('sessions that ended while Mason was away, in Since you last looked', () => {
  it('names each one with how it ended, failed first, even when the Leader said nothing', async () => {
    const now = Date.now();
    lastLooked(now - 30 * MIN);
    serve(awayFleet(now, THREE));
    render(<LeaderThreadPane visible />);
    const region = await screen.findByRole('region', { name: 'Since you last looked' });
    const list = within(region).getByRole('list', { name: ENDED });
    expect(within(list).getAllByRole('listitem').map(item => item.querySelector('button')!.textContent)).toEqual(['RQ-FAILED', 'RQ-PR']);
    expect(rowOf(list, 'RQ-FAILED')).toHaveAttribute('data-state', 'failed');
    expect(rowOf(list, 'RQ-FAILED').querySelector('time')).toHaveTextContent('failed 5m ago');
    expect(rowOf(list, 'RQ-FAILED').querySelector('time')).toHaveAttribute('datetime', iso(now - 5 * MIN));
    expect(rowOf(list, 'RQ-PR')).toHaveAttribute('data-state', 'done');
    expect(rowOf(list, 'RQ-PR')).toHaveTextContent('finished 12m ago');
    expect(rowOf(list, 'RQ-PR')).toHaveTextContent('Opened a pull request');
    expect(within(region).getByText('1 finished · 1 failed')).toBeInTheDocument();
    // A failure is something to look at, so the card takes the attention rule.
    expect(region).toHaveAttribute('data-attention', 'true');
    // Nothing arrived in the conversation, so there is no count line and nothing to jump to.
    expect(within(region).queryByRole('list', { name: 'What arrived' })).toBeNull();
    expect(within(region).queryByRole('button', { name: 'Jump to first new' })).toBeNull();
    expect(region.querySelector('[data-away-sessions="unknown"]')).toBeNull();
  });

  it('sits under the counts when the Leader also spoke, and says a finished session with no outcome has none on record', async () => {
    const now = Date.now();
    lastLooked(now - 30 * MIN);
    serve(awayFleet(now, [{ job: 'RQ-QUIETLY', minutesAgo: 4, outcome: null }]), [msg({ id: 'new', at: iso(now - 10 * MIN), text: 'The judge queue is clear.' })]);
    render(<LeaderThreadPane visible />);
    const region = await screen.findByRole('region', { name: 'Since you last looked' });
    const arrived = await within(region).findByRole('list', { name: 'What arrived' });
    const list = await within(region).findByRole('list', { name: ENDED });
    expect(arrived.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(rowOf(list, 'RQ-QUIETLY')).getByText('Outcome unknown')).toHaveAttribute('data-unknown', 'true');
    expect(region).not.toHaveAttribute('data-attention');
  });

  it('says the endings are unknown when the session list cannot be read, never that none ended', async () => {
    const now = Date.now();
    lastLooked(now - 30 * MIN);
    serve(null, [msg({ id: 'new', at: iso(now - 10 * MIN), text: 'The judge queue is clear.' })]);
    render(<LeaderThreadPane visible />);
    const region = await screen.findByRole('region', { name: 'Since you last looked' });
    const note = await within(region).findByText('Sessions that ended while you were away: unknown, the session list could not be read.');
    expect(note).toHaveAttribute('data-tone', 'unknown');
    expect(within(region).queryByRole('list', { name: ENDED })).toBeNull();
  });

  it('does not raise the card for an unreadable session list alone, or for a list in which nothing ended', async () => {
    const now = Date.now();
    lastLooked(now - 30 * MIN);
    const first = serve(null);
    const one = render(<LeaderThreadPane visible />);
    await waitFor(() => expect(first.fetchMock.mock.calls.some(([input]) => String(input).startsWith(LIVE_SESSIONS_API))).toBe(true));
    await screen.findByRole('log', { name: 'Conversation with the Leader' });
    expect(card()).toBeNull();
    one.unmount();

    evictAll();
    lastLooked(now - 30 * MIN);
    const second = serve(awayFleet(now, [{ job: 'RQ-BEFORE', minutesAgo: 50, outcome: 'empty' }]));
    render(<LeaderThreadPane visible />);
    await waitFor(() => expect(second.fetchMock.mock.calls.some(([input]) => String(input).startsWith(LIVE_SESSIONS_API))).toBe(true));
    await screen.findByRole('log', { name: 'Conversation with the Leader' });
    expect(card()).toBeNull();
  });

  it('says an absence longer than the list remembers covers the last hour only', async () => {
    const now = Date.now();
    lastLooked(now - 3 * HOUR);
    serve(awayFleet(now, THREE));
    render(<LeaderThreadPane visible />);
    const region = await screen.findByRole('region', { name: 'Since you last looked' });
    expect(await within(region).findByText('2 finished · 1 failed in the last hour')).toBeInTheDocument();
    expect(within(region).getByText('Sessions that ended before the last hour are not in the session list.')).toHaveAttribute('data-tone', 'unknown');
  });

  it('folds finished sessions past the first few behind Show all, and never a failed one', async () => {
    const now = Date.now();
    lastLooked(now - 30 * MIN);
    serve(awayFleet(now, [
      ...Array.from({ length: 6 }, (_, index) => ({ job: `RQ-DONE${index}`, minutesAgo: 3 + index, outcome: 'pr' as const })),
      { job: 'RQ-FAILED', minutesAgo: 20, outcome: 'failed' as const },
    ]));
    render(<LeaderThreadPane visible />);
    const region = await screen.findByRole('region', { name: 'Since you last looked' });
    const list = within(region).getByRole('list', { name: ENDED });
    expect(within(list).getAllByRole('listitem').map(item => item.querySelector('button')!.textContent)).toEqual(['RQ-FAILED', 'RQ-DONE0', 'RQ-DONE1', 'RQ-DONE2']);
    const more = within(region).getByRole('button', { name: 'Show all 7' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(more);
    expect(within(list).getAllByRole('listitem')).toHaveLength(7);
    fireEvent.click(within(region).getByRole('button', { name: 'Show fewer' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(4);
  });

  it('opens a session beside the chat from its row and marks the row while it is open', async () => {
    paneWidth(1280);
    const now = Date.now();
    lastLooked(now - 30 * MIN);
    serve(awayFleet(now, THREE));
    render(<LeaderSurface visible host={host()} />);
    const region = await screen.findByRole('region', { name: 'Since you last looked' });
    const list = within(region).getByRole('list', { name: ENDED });
    const door = within(list).getByRole('button', { name: /^Open the conversation with RQ-FAILED, failed 5m ago$/ });
    door.focus();
    fireEvent.click(door);
    expect(await screen.findByText('RQ-FAILED stopped on a failing test')).toBeInTheDocument();
    expect(door).toHaveAttribute('aria-current', 'true');
    expect(rowOf(list, 'RQ-FAILED')).toHaveAttribute('data-open', 'true');
    expect(rowOf(list, 'RQ-PR')).not.toHaveAttribute('data-open');
    // The card is still up beside the conversation, and the chat was not left.
    expect(card()).not.toBeNull();
    expect(takeRequestedWallSession()).toBeNull();
  });

  it('opens the session in Conversations when no Leader pane holds the chat', async () => {
    const now = Date.now();
    lastLooked(now - 30 * MIN);
    serve(awayFleet(now, THREE));
    render(<LeaderThreadPane visible />);
    const region = await screen.findByRole('region', { name: 'Since you last looked' });
    fireEvent.click(within(region).getByRole('button', { name: /^Open the conversation with RQ-PR,/ }));
    expect(takeRequestedWallSession()).toBe('RQ-PR');
  });
});
