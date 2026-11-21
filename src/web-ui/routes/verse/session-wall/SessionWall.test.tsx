import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { takeRequestedWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { getPane } from '../panes/pane-registry.js';
import { REGISTERED_DOCK_PANE_GROUPS } from '../shell/dock-pane-catalog.js';
import { mockViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { SessionWallPane, WallView } from './SessionWall.js';
import { narrowSessionWall, replyLine, wallHeadline } from './session-wall-model.js';
import './session-wall.pane.js';
import { forgetWallSeen } from './wall-seen.js';
import { forgetThreadDrafts, setThreadDraft } from '../fleet-sessions/thread-draft-store.js';
import { requestWallSession, takeRequestedWallSession } from './wall-selection.js';

const AT = '2026-11-18T12:00:00.000Z';
const session = (id: string, over: Record<string, unknown> = {}) => ({ id, kind: 'worker', agent: 'claude', lane: 'claude', model: 'fixture-model', repo: 'phantom',
  jobId: id, parentId: 'leader', state: 'running', startedAt: null, ageSeconds: 1800, lastMessageAt: null, lastMessageAgeSeconds: 120, prUrl: null,
  computer: 'unknown', helpers: { below: 0, running: 0, failed: 0 }, ...over });
const message = (key: string, side: string, label: string, text: string, over: Record<string, unknown> = {}) => ({ key, kind: key.split(':')[0], side, label, at: null, text, format: 'plain', ...over });
const sources = { sessions: 'available', activity: 'available', bus: 'none', owner: 'available', replies: 'none', orders: 'none' };

/** The wire document, as GET /api/verse/fleet/control/session-threads answers (CONTRACT.md, "Session threads"). */
function threads(over: Record<string, unknown> = {}) {
  return {
    schema: 'fleet.session-threads.v1', generatedAt: AT, filter: { lane: null, repo: null, live: false },
    counts: { sessions: 4, shown: 4, states: { running: 1, quiet: 1, idle: 1, done: 1, failed: 0, unknown: 0 } },
    threads: [
      { session: session('leader', { kind: 'leader', lane: 'unknown', model: 'unknown', repo: 'unknown', jobId: null, parentId: null, state: 'idle', lastMessageAgeSeconds: 360 }),
        summary: ['leader is the leader.', 'It is idle between passes.'], messageCount: 2, sources, gaps: [],
        messages: [message('owner:1', 'other', 'Mason', 'Ship the wall today.', { at: '2026-11-18T11:50:00.000Z' }), message('reply:1', 'session', 'Leader', 'Routed to **claude**.', { format: 'markdown' })] },
      { session: session('RQ-A'), summary: ['RQ-A is a worker on claude.', 'It is running.'], messageCount: 9, sources, gaps: [], reply: { to: 'job', mention: '@RQ-A', hint: 'Goes to the Leader\'s inbox with @RQ-A in front, so the Leader knows which session you mean.' },
        messages: [message('step:4', 'record', 'Step 4', 'Ran the tests'), message('bus:7', 'other', 'leader on the bus', 'Keep the diff small.'), message('latest', 'session', 'RQ-A', 'Running the web suite now.', { truncated: true })] },
      { session: session('helper-a', { kind: 'subagent', jobId: null, parentId: 'RQ-A', state: 'quiet', lastMessageAgeSeconds: null }), summary: [], messageCount: 0, sources, gaps: [], messages: [] },
      { session: session('RQ-DONE', { state: 'done', prUrl: 'https://github.com/ashlrai/phantom/pull/9' }), summary: ['RQ-DONE finished.'], messageCount: 1, sources, gaps: [],
        messages: [message('latest', 'session', 'RQ-DONE', 'Opened the pull request.')] },
    ],
    sources: { sessions: 'available', bus: 'available', replies: 'available' }, gaps: ['Bus messages unknown: the agent bus could not be read.'], ...over,
  };
}
const thread = (id: string, over: Record<string, unknown> = {}) => ({
  schema: 'fleet.session-thread.v1', generatedAt: AT, id, session: session(id), summary: [`${id} is a worker on claude.`, 'It has run 3 commands.'],
  messages: [message('brief', 'other', 'Brief', 'Build the wall.'), message('step:1', 'record', 'Step 1', 'Read the docs'),
    message('commands', 'session', `${id} ran`, 'npm run build', { format: 'mono' }), message('latest', 'session', id, 'Done with **tests**.', { format: 'markdown' })],
  sources, gaps: ['Notes unknown: none recorded.'], ...over });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
/** Answers both reads and takes a message for the Leader inbox; `single` builds the opened conversation's response. */
function serve(wall: () => Response, single: (id: string) => Response = id => json(thread(id))) {
  const fetch = vi.fn(async (input: unknown, _init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === INBOX) return json({ ok: true });
    return url.pathname.endsWith('/session-thread') ? single(url.searchParams.get('id')!) : wall();
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const INBOX = '/api/verse/leader/inbox';
const sentToInbox = (fetch: ReturnType<typeof serve>) => fetch.mock.calls.filter(call => String(call[0]).endsWith(INBOX)).map(call => JSON.parse(String(call[1]?.body)) as { text: string });
const host = () => ({ openPane: vi.fn() });
const card = (id: string) => screen.getByRole('button', { name: new RegExp(`^${id}, `) });

let viewport: ViewportMock | null = null;
beforeEach(() => { evictAll(); forgetWallSeen(); forgetThreadDrafts(); setMutationToken('a'.repeat(64)); takeRequestedWorkerLogJob(); takeRequestedWallSession(); });
afterEach(() => { cleanup(); viewport?.restore(); viewport = null; vi.unstubAllGlobals(); vi.restoreAllMocks(); clearMutationToken(); });

it('registers a session-independent Conversations pane beside the Leader chat', () => {
  expect(getPane('session-wall')).toMatchObject({ id: 'session-wall', title: 'Conversations', needsSession: false });
  expect(REGISTERED_DOCK_PANE_GROUPS['session-wall']).toBe('talk');
});

describe.each([['desktop width', 1440], ['390 px', 390]])('the wall at %s', (_name, width) => {
  it('shows every session as a short conversation, in the order the read gives', () => {
    viewport = mockViewport(width);
    render(<WallView read={narrowSessionWall(threads())!} onOpen={() => {}} />);
    expect(screen.getByText('4 sessions: 1 running, 1 quiet, 1 idle, 1 done')).toBeTruthy();
    const cards = within(screen.getByRole('list', { name: 'Conversations' })).getAllByRole('listitem');
    expect(cards.map(item => [item.querySelector('strong')?.textContent, item.dataset.state])).toEqual([['leader', 'idle'], ['RQ-A', 'running'], ['helper-a', 'quiet'], ['RQ-DONE', 'done']]);
    for (const fact of ['leader', 'model unknown', 'repo unknown', 'spoke 6m ago', 'leader is the leader. It is idle between passes.']) expect(cards[0]!.textContent).toContain(fact);
    // Said to the session reads on the right, the session on the left; a card keeps markdown as plain text.
    expect([...cards[0]!.querySelectorAll('[data-side]')].map(line => [line.getAttribute('data-side'), line.textContent])).toEqual([
      ['other', expect.stringMatching(/^Mason · .+Ship the wall today\.$/)], ['session', 'LeaderRouted to **claude**.']]);
    expect(cards[1]!.textContent).toContain('6 earlier');
    expect(cards[1]!.textContent).toContain('Step 4: Ran the tests');
    for (const fact of ['subagent', 'helps RQ-A', 'last spoke unknown', 'Summary unknown: the read returned none.', 'Nothing is recorded for this session yet.']) expect(cards[2]!.textContent).toContain(fact);
    // Each card ends with where a reply would go: the read's answer for RQ-A, the same rule applied here for the others.
    expect(cards.map(item => { const to = item.querySelector('[data-to]')!; return [to.getAttribute('data-to'), to.textContent]; })).toEqual([
      ['leader', 'Reply goes to the Leader\'s inbox'], ['job', 'Reply goes to @RQ-A'], ['none', 'Read only'], ['none', 'Read only']]);
    expect(cards[1]!.querySelector('[data-to]')!.getAttribute('title')).toBe('Goes to the Leader\'s inbox with @RQ-A in front, so the Leader knows which session you mean.');
    expect(cards[3]!.querySelector('[data-to]')!.getAttribute('title')).toBe('This session is not running, so there is nothing to steer. Write to the Leader in the Leader chat.');
    expect(card('RQ-A').getAttribute('aria-describedby')).toBe(within(cards[1]!).getByText('RQ-A is a worker on claude. It is running.').id);
    expect(within(screen.getByRole('list', { name: 'Not shown' })).getByText('Bus messages unknown: the agent bus could not be read.')).toBeTruthy();
  });
});

it('filters by state, and falls back to every session when that state empties', () => {
  const view = render(<WallView read={narrowSessionWall(threads())!} onOpen={() => {}} />);
  const filters = screen.getByRole('group', { name: 'Show sessions by state' });
  expect(within(filters).getAllByRole('button').map(button => button.textContent)).toEqual(['All 4', 'running 1', 'quiet 1', 'idle 1', 'done 1']);
  fireEvent.click(within(filters).getByRole('button', { name: 'quiet 1' }));
  const cards = () => within(screen.getByRole('list', { name: 'Conversations' })).getAllByRole('listitem');
  expect(cards().map(item => item.querySelector('strong')?.textContent)).toEqual(['helper-a']);
  expect(within(filters).getByRole('button', { name: 'quiet 1' }).getAttribute('aria-pressed')).toBe('true');
  const next = threads();
  (next.threads[2]!.session as { state: string }).state = 'running';
  view.rerender(<WallView read={narrowSessionWall(next)!} onOpen={() => {}} />);
  expect(cards()).toHaveLength(4);
  expect(within(filters).getByRole('button', { name: 'All 4' }).getAttribute('aria-pressed')).toBe('true');
});

describe('where the Leader routed a message', () => {
  const routed = 'RQ-A, on claude: published https://github.com/ashlrai/phantom/pull/9\nRQ-B, lane unknown: queued';
  const routing = message('routing:1', 'record', 'Routed to 2 jobs', routed);
  const asked = message('owner:1', 'other', 'Mason to Leader, from desktop', 'Ship the wall today.', { at: '2026-11-18T11:50:00.000Z' });
  const leader = session('leader', { kind: 'leader', lane: 'unknown', model: 'unknown', repo: 'unknown', jobId: null, parentId: null, state: 'idle' });

  it('shows it on the leader\'s card in one line', () => {
    const wall = threads();
    wall.threads[0] = { ...wall.threads[0]!, messages: [asked, routing], messageCount: 2 };
    render(<WallView read={narrowSessionWall(wall)!} onOpen={vi.fn()} />);
    const line = card('leader').querySelector('[data-kind="routing"]');
    expect(line?.textContent).toBe('Routed to 2 jobs: RQ-A, on claude: published https://github.com/ashlrai/phantom/pull/9 · RQ-B, lane unknown: queued');
  });

  it('lists each job under the message in the opened conversation, with its pull request as a link', async () => {
    serve(() => json(threads()), id => json(thread(id, { session: leader, messages: [asked, routing], sources: { ...sources, orders: 'available' } })));
    render(<SessionWallPane visible host={host() as never} />);
    fireEvent.click(await screen.findByRole('button', { name: 'leader, idle' }));
    await screen.findByRole('list', { name: 'Conversation with leader' });
    const record = document.querySelector('li[data-kind="routing"]')!;
    expect(record.firstElementChild?.textContent).toBe('Routed to 2 jobs');
    const jobs = within(record as HTMLElement).getAllByRole('listitem');
    expect(jobs.map(job => job.textContent)).toEqual(['RQ-A, on claude: published PR #9', 'RQ-B, lane unknown: queued']);
    expect(within(jobs[0]!).getByRole('link', { name: 'PR #9' }).getAttribute('href')).toBe('https://github.com/ashlrai/phantom/pull/9');
    expect(within(jobs[1]!).queryByRole('link')).toBeNull();
    expect(screen.getByText(/replies to you none recorded · routing shown$/)).toBeTruthy();
  });

  it('says routing is unknown, not absent, when the opened read carries no trace', async () => {
    // A server that predates routing sends no `orders` key: unknown, not "none recorded".
    serve(() => json(threads()), id => json(thread(id, { sources: { ...sources, orders: undefined } })));
    render(<SessionWallPane visible host={host() as never} />);
    fireEvent.click(await screen.findByRole('button', { name: 'RQ-A, running' }));
    expect(await screen.findByText(/routing unknown$/)).toBeTruthy();
  });
});

it('moves between cards with the arrow keys, J and K, Home and End', () => {
  const onOpen = vi.fn();
  render(<WallView read={narrowSessionWall(threads())!} onOpen={onOpen} />);
  card('leader').focus();
  const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(document.activeElement!, { key, ...init });
  press('ArrowDown'); expect(document.activeElement).toBe(card('RQ-A'));
  press('j'); press('ArrowRight'); press('ArrowRight'); expect(document.activeElement).toBe(card('RQ-DONE'));
  press('k'); expect(document.activeElement).toBe(card('helper-a'));
  press('Home'); press('ArrowUp'); expect(document.activeElement).toBe(card('leader'));
  press('End'); expect(document.activeElement).toBe(card('RQ-DONE'));
  press('j', { metaKey: true }); expect(document.activeElement).toBe(card('RQ-DONE'));
  fireEvent.click(card('RQ-A'));
  expect(onOpen).toHaveBeenCalledWith('RQ-A');
});

it('opens a card as the whole conversation, sends a reply aimed at it, and comes back to the same card', async () => {
  const fetch = serve(() => json(threads()));
  const pane = host();
  render(<SessionWallPane visible host={pane as never} />);
  fireEvent.click(await screen.findByRole('button', { name: 'RQ-A, running' }));
  const open = screen.getByRole('region', { name: 'Session RQ-A' });
  expect(within(open).getByRole('button', { name: 'Back to every conversation' }).textContent).toBe('← All');
  const log = await screen.findByRole('list', { name: 'Conversation with RQ-A' });
  expect(fetch.mock.calls.map(call => String(call[0])).at(-1)).toContain('/api/verse/fleet/control/session-thread?id=RQ-A');
  expect(open.querySelector('[data-state="running"]')?.textContent).toBe('running');
  expect(within(screen.getByLabelText('Summary')).getByText('It has run 3 commands.')).toBeTruthy();
  expect(within(log).getAllByRole('listitem').map(item => [item.getAttribute('data-side'), item.textContent])).toEqual([
    ['other', 'BriefBuild the wall.'], ['record', 'Step 1Read the docs'], ['session', 'RQ-A rannpm run build'], ['session', expect.stringContaining('Done with')]]);
  expect(log.querySelector('pre')?.textContent).toBe('npm run build');
  expect(screen.getByText('Activity shown · bus messages none recorded · your messages shown · routing none recorded')).toBeTruthy();
  expect(within(screen.getByRole('list', { name: 'Not shown' })).getByText('Notes unknown: none recorded.')).toBeTruthy();

  // The reply is sent from here, through the Leader's inbox, with the session's job in front.
  const box = screen.getByRole('textbox', { name: 'Message RQ-A' });
  expect(document.activeElement).not.toBe(box);
  fireEvent.change(box, { target: { value: 'Keep the diff small.' } });
  fireEvent.keyDown(box, { key: 'Enter' });
  await waitFor(() => expect(sentToInbox(fetch)).toEqual([{ text: '@RQ-A Keep the diff small.', source: 'Phantom desktop' }]));
  expect(await screen.findByText(/In the Leader's inbox\./)).toBeTruthy();
  expect(pane.openPane).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Live log' }));
  expect(takeRequestedWorkerLogJob()).toBe('RQ-A');
  expect(pane.openPane).toHaveBeenLastCalledWith('worker-log');

  // Esc in a reply box that holds words keeps them; from the conversation it returns to the card it was opened from.
  fireEvent.change(box, { target: { value: 'half a thought' } });
  fireEvent.keyDown(box, { key: 'Escape' });
  expect(screen.getByRole('region', { name: 'Session RQ-A' })).toBeTruthy();
  fireEvent.keyDown(open, { key: 'Escape' });
  await waitFor(() => expect(document.activeElement).toBe(card('RQ-A')));
  expect(screen.queryByRole('region', { name: 'Session RQ-A' })).toBeNull();
});

it('opens a card ready to reply with R, and reads a session that cannot be written to without a box', async () => {
  serve(() => json(threads()), id => json(thread(id, id === 'RQ-DONE' ? { session: threads().threads[3]!.session } : {})));
  render(<SessionWallPane visible host={host() as never} />);
  (await screen.findByRole('button', { name: 'RQ-A, running' })).focus();
  fireEvent.keyDown(document.activeElement!, { key: 'r' });
  const box = await screen.findByRole('textbox', { name: 'Message RQ-A' });
  await waitFor(() => expect(document.activeElement).toBe(box));
  fireEvent.keyDown(box, { key: 'Escape' });
  await waitFor(() => expect(document.activeElement).toBe(card('RQ-A')));

  // R on a finished session still opens it; there is no box to put the cursor in, and the reason is on screen.
  card('RQ-DONE').focus();
  fireEvent.keyDown(document.activeElement!, { key: 'r' });
  await screen.findByRole('list', { name: 'Conversation with RQ-DONE' });
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.getByRole('note').textContent).toBe('This session is not running, so there is nothing to steer. Write to the Leader in the Leader chat.');
});

it('opens the one conversation another surface asked for, once, whether the pane is already open or not', async () => {
  const fetch = serve(() => json(threads()));
  // Asked before the pane exists: a routed job in the Leader chat opens the pane straight onto its conversation.
  requestWallSession('RQ-A');
  const first = render(<SessionWallPane visible host={host() as never} />);
  expect(screen.getByRole('region', { name: 'Session RQ-A' })).toBeTruthy();
  // Asked for from elsewhere, it opens for reading: the cursor is not put in the reply box.
  await screen.findByRole('list', { name: 'Conversation with RQ-A' });
  expect(document.activeElement).not.toBe(screen.getByRole('textbox', { name: 'Message RQ-A' }));
  expect(fetch.mock.calls.map(call => String(call[0])).some(url => url.includes('/session-thread?id=RQ-A'))).toBe(true);
  expect(takeRequestedWallSession()).toBeNull();
  // Going back shows the wall; the spent request does not reopen it.
  fireEvent.click(screen.getByRole('button', { name: 'Back to every conversation' }));
  expect(await screen.findByRole('button', { name: 'RQ-A, running' })).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Session RQ-A' })).toBeNull();
  // Asked while the wall is on screen.
  act(() => requestWallSession('RQ-DONE'));
  expect(screen.getByRole('region', { name: 'Session RQ-DONE' })).toBeTruthy();
  first.unmount();

  // Free text is never a session id, and a session that has left the list says so instead of showing a blank.
  requestWallSession('not an id; drop table');
  expect(takeRequestedWallSession()).toBeNull();
  evictAll();
  serve(() => json(threads()), () => json({ error: 'No session RQ-OLD in the list.' }, 404));
  requestWallSession('RQ-OLD');
  render(<SessionWallPane visible host={host() as never} />);
  const gone = await screen.findByRole('alert');
  expect(gone.dataset.kind).toBe('gone');
  expect(gone.textContent).toContain('No session RQ-OLD in the list.');
});

it('offers no reply box to a finished session, and writes to the leader as the Leader chat does', async () => {
  const fetch = serve(() => json(threads()), id => json(thread(id, { session: id === 'leader' ? threads().threads[0]!.session : threads().threads[3]!.session })));
  const pane = host();
  render(<SessionWallPane visible host={pane as never} />);
  fireEvent.click(await screen.findByRole('button', { name: 'RQ-DONE, done' }));
  await screen.findByRole('list', { name: 'Conversation with RQ-DONE' });
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.getByRole('note').textContent).toBe('This session is not running, so there is nothing to steer. Write to the Leader in the Leader chat.');
  expect(screen.getByRole('link', { name: 'Pull request' }).getAttribute('href')).toBe('https://github.com/ashlrai/phantom/pull/9');
  fireEvent.click(screen.getByRole('button', { name: 'Back to every conversation' }));
  fireEvent.click(await screen.findByRole('button', { name: 'leader, idle' }));
  const box = await screen.findByRole('textbox', { name: 'Message the Leader' });
  expect(screen.queryByRole('note')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Live log' })).toBeNull();
  fireEvent.change(box, { target: { value: 'How is the fleet?' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(sentToInbox(fetch)).toEqual([{ text: 'How is the fleet?', source: 'Phantom desktop' }]));
  expect(pane.openPane).not.toHaveBeenCalled();
});

it('says why when the wall or a conversation cannot be read', async () => {
  serve(() => json({ error: 'not found' }, 404));
  const pane = host();
  const view = render(<SessionWallPane visible host={pane as never} />);
  expect(screen.getByRole('status').textContent).toBe('Reading every session…');
  const fault = await screen.findByRole('alert');
  expect(fault.textContent).toContain('This Phantom server cannot read every session as a conversation yet.');
  expect(within(fault).queryByRole('button', { name: 'Try again' })).toBeNull();
  fireEvent.click(within(fault).getByRole('button', { name: 'Open Sessions' }));
  expect(pane.openPane).toHaveBeenCalledWith('fleet-sessions');
  view.unmount();

  evictAll();
  const retry = serve(() => json({ error: 'Sessions unavailable.' }, 503));
  const second = render(<SessionWallPane visible host={pane as never} />);
  const down = await screen.findByRole('alert');
  expect(down.textContent).toContain('The session list could not be read just now.');
  const asked = retry.mock.calls.length;
  fireEvent.click(within(down).getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(retry.mock.calls.length).toBeGreaterThan(asked));
  second.unmount();

  evictAll();
  serve(() => json({ schema: 'fleet.live-sessions.v1', sessions: [] }));
  const third = render(<SessionWallPane visible host={pane as never} />);
  expect((await screen.findByRole('alert')).textContent).toBe('The server answered with something that is not a list of session conversations.');
  third.unmount();

  evictAll();
  serve(() => json(threads()), () => json({ error: 'No session RQ-A in the list.' }, 404));
  render(<SessionWallPane visible host={pane as never} />);
  fireEvent.click(await screen.findByRole('button', { name: 'RQ-A, running' }));
  const gone = await screen.findByRole('alert');
  expect(gone.dataset.kind).toBe('gone');
  expect(gone.textContent).toContain('No session RQ-A in the list.');
});

it('narrows defensively: bad entries dropped, unsafe links removed, unknown kept as unknown', () => {
  expect(narrowSessionWall({ schema: 'fleet.session-thread.v1', threads: [] })).toBeNull();
  const read = narrowSessionWall({ schema: 'fleet.session-threads.v1', counts: { sessions: 45 }, threads: [
    { session: { id: 'RQ-X', state: 'odd', prUrl: 'javascript:alert(1)', lastMessageAgeSeconds: -4 }, messageCount: 1, summary: ['ok', 7, ''],
      messages: [message('latest', 'session', 'RQ-X', 'one'), message('latest', 'session', 'RQ-X', 'duplicate key'), { key: 'bus:1' }, 7, message('bus:2', 'sideways', '', 'two', { at: 'never', format: 'html' })] },
    { session: { id: 'RQ-X' } }, { session: {} }, { summary: [] }, 7] })!;
  expect(read.entries).toHaveLength(1);
  expect(read.entries[0]!.session).toEqual({ id: 'RQ-X', kind: 'worker', lane: 'unknown', model: 'unknown', repo: 'unknown', jobId: null, parentId: null, state: 'unknown', lastMessageAgeSeconds: null, prUrl: null, helpers: null });
  expect(read.entries[0]).toMatchObject({ summary: ['ok'], messageCount: 2, messages: [{ key: 'latest', text: 'one', truncated: false }, { key: 'bus:2', side: 'record', label: 'Unlabelled', at: null, format: 'plain' }] });
  expect(wallHeadline(read)).toBe('1 of 45 sessions: 1 state unknown');
  // A body never gets to aim Mason's words at another session: the rule is applied here instead.
  const aimed = (reply: unknown, over: Record<string, unknown> = {}) => narrowSessionWall(threads({ threads: [{ session: session('RQ-A', over), reply }] }))!.entries[0]!.reply;
  expect(aimed({ to: 'job', mention: '@RQ-OTHER', hint: 'Goes elsewhere.' })).toMatchObject({ to: 'job', job: 'RQ-A' });
  expect(aimed({ to: 'leader', mention: null, hint: 'Goes to the Leader.' })).toMatchObject({ to: 'job', job: 'RQ-A' });
  expect(aimed({ to: 'none', mention: null, hint: 'Held by the server.' })).toEqual({ to: 'none', hint: 'Held by the server.' });
  expect(replyLine(aimed('nonsense', { state: 'done' }))).toBe('Read only');
  expect(wallHeadline(narrowSessionWall(threads({ threads: [], counts: { sessions: 0 } }))!)).toBe('No agent sessions');
  render(<WallView read={narrowSessionWall(threads({ threads: [], counts: { sessions: 0 } }))!} onOpen={() => {}} />);
  expect(screen.getByRole('status').textContent).toBe('No agent sessions right now. Each one appears here as the fleet starts it.');
  expect(screen.queryByRole('group', { name: 'Show sessions by state' })).toBeNull();
});

describe('words typed to a session and not sent', () => {
  const row = (id: string) => document.querySelector(`button[data-rail="${id}"]`)!;
  const describedBy = (button: Element) => (button.getAttribute('aria-describedby') ?? '').split(' ').map(id => document.getElementById(id)?.textContent);

  it('stay with that session as conversations change, and mark its row and its card "Draft"', async () => {
    serve(() => json(threads()));
    render(<SessionWallPane visible host={host() as never} />);
    fireEvent.click(await screen.findByRole('button', { name: 'RQ-A, running' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Message RQ-A' }), { target: { value: 'half a thought' } });
    // Its own row says nothing while its reply box is on screen.
    expect(row('RQ-A').querySelector('[data-draft-mark]')).toBeNull();

    // Another conversation opens in its place: an empty box, and the row left behind says a draft waits there.
    fireEvent.click(row('RQ-DONE'));
    const other = await screen.findByRole('textbox', { name: 'Message RQ-DONE' }) as HTMLTextAreaElement;
    expect(other.value).toBe('');
    expect(row('RQ-A').querySelector('[data-draft-mark]')!.textContent).toBe('Draft');
    expect(row('RQ-DONE').querySelector('[data-draft-mark]')).toBeNull();

    // Back on the cards, the card says so too, and reads it out with the rest of what describes it.
    fireEvent.click(screen.getByRole('button', { name: 'Back to every conversation' }));
    const a = await screen.findByRole('button', { name: 'RQ-A, running' });
    expect(a.querySelector('[data-draft-mark="RQ-A"]')!.textContent).toBe('Draft');
    expect(describedBy(a)).toContain('Draft');
    expect(describedBy(card('RQ-DONE'))).not.toContain('Draft');

    // Opened again, the words are in the box; once they are cleared the mark goes.
    fireEvent.click(a);
    expect((await screen.findByRole('textbox', { name: 'Message RQ-A' }) as HTMLTextAreaElement).value).toBe('half a thought');
    act(() => setThreadDraft('RQ-A', ''));
    expect(document.querySelector('[data-draft-mark]')).toBeNull();
  });

  it('leave the card unmarked while that conversation is beside the cards', () => {
    setThreadDraft('leader', 'to the Leader');
    setThreadDraft('RQ-A', 'to a worker');
    render(<WallView read={narrowSessionWall(threads())!} onOpen={() => {}} readingId="leader" />);
    expect(card('leader').querySelector('[data-draft-mark]')).toBeNull();
    expect(describedBy(card('leader'))).not.toContain('Draft');
    expect(card('RQ-A').querySelector('[data-draft-mark]')).not.toBeNull();
  });
});
