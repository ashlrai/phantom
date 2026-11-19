import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { takeRequestedWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { takeLeaderDraft } from '../leader-thread/leader-draft-store.js';
import { getPane } from '../panes/pane-registry.js';
import { REGISTERED_DOCK_PANE_GROUPS } from '../shell/dock-pane-catalog.js';
import { mockViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { SessionWallPane, WallView } from './SessionWall.js';
import { aimableJob, narrowOpenThread, narrowSessionWall, routedJobs, sourcesLine, wallHeadline } from './session-wall-model.js';
import './session-wall.pane.js';

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
      { session: session('RQ-A'), summary: ['RQ-A is a worker on claude.', 'It is running.'], messageCount: 9, sources, gaps: [],
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
/** Answers both reads; `single` builds the opened conversation's response. */
function serve(wall: () => Response, single: (id: string) => Response = id => json(thread(id))) {
  const fetch = vi.fn(async (input: unknown) => {
    const url = new URL(String(input), 'http://localhost');
    return url.pathname.endsWith('/session-thread') ? single(url.searchParams.get('id')!) : wall();
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const host = () => ({ openPane: vi.fn() });
const card = (id: string) => screen.getByRole('button', { name: new RegExp(`^${id}, `) });

let viewport: ViewportMock | null = null;
beforeEach(() => { evictAll(); takeLeaderDraft(); takeRequestedWorkerLogJob(); });
afterEach(() => { cleanup(); viewport?.restore(); viewport = null; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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
    const jobs = within(await screen.findByRole('list', { name: 'Routed to 2 jobs' })).getAllByRole('listitem');
    expect(jobs.map(job => job.textContent)).toEqual(['RQ-A, on claude: published #9', 'RQ-B, lane unknown: queued']);
    expect(within(jobs[0]!).getByRole('link', { name: 'Pull request 9' }).getAttribute('href')).toBe('https://github.com/ashlrai/phantom/pull/9');
    expect(within(jobs[1]!).queryByRole('link')).toBeNull();
    expect(screen.getByText(/replies to you none recorded · routing shown$/)).toBeTruthy();
  });

  it('keeps the server\'s words and never reads a missing trace as nothing routed', () => {
    expect(routedJobs(routed)).toEqual([{ text: 'RQ-A, on claude: published', pr: { url: 'https://github.com/ashlrai/phantom/pull/9', number: '9' } }, { text: 'RQ-B, lane unknown: queued', pr: null }]);
    // A link that is not a GitHub pull request stays text; nothing is made clickable from it.
    expect(routedJobs('RQ-C: published https://example.com/pull/3\n\n')).toEqual([{ text: 'RQ-C: published https://example.com/pull/3', pr: null }]);
    const line = (kind: string, over: Record<string, unknown>) => sourcesLine(narrowOpenThread(thread('x', { session: session('x', { kind }), sources: { ...sources, ...over } }))!);
    expect(line('worker', { orders: 'unavailable' })).toMatch(/routing unknown$/);
    // A server that predates routing sends no `orders` key: unknown, not "none recorded".
    expect(line('worker', { orders: undefined })).toMatch(/routing unknown$/);
    expect(line('subagent', { orders: 'none' })).not.toContain('routing');
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

it('opens a card as the whole conversation, hands a message to the Leader box, and comes back to the same card', async () => {
  const fetch = serve(() => json(threads()));
  const pane = host();
  render(<SessionWallPane visible host={pane as never} />);
  fireEvent.click(await screen.findByRole('button', { name: 'RQ-A, running' }));
  const open = screen.getByRole('region', { name: 'Conversation with RQ-A' });
  // The card's own facts fill the header before the thread answers.
  expect(open.querySelector('[data-state="running"]')?.textContent).toBe('running');
  const log = await screen.findByRole('list', { name: 'Conversation with RQ-A' });
  expect(fetch.mock.calls.map(call => String(call[0])).at(-1)).toContain('/api/verse/fleet/control/session-thread?id=RQ-A');
  expect(within(screen.getByLabelText('Summary')).getByText('It has run 3 commands.')).toBeTruthy();
  expect(within(log).getAllByRole('listitem').map(item => [item.getAttribute('data-side'), item.textContent])).toEqual([
    ['other', 'BriefBuild the wall.'], ['record', 'Step 1 Read the docs'], ['session', 'RQ-A rannpm run build'], ['session', expect.stringContaining('Done with')]]);
  expect(log.querySelector('pre')?.textContent).toBe('npm run build');
  expect(screen.getByText('Activity shown · bus messages none recorded · your messages shown · routing none recorded')).toBeTruthy();
  expect(within(screen.getByRole('list', { name: 'Not shown' })).getByText('Notes unknown: none recorded.')).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Write to it' }));
  expect(takeLeaderDraft()).toBe('@RQ-A ');
  expect(pane.openPane).toHaveBeenLastCalledWith('leader-thread');
  fireEvent.click(screen.getByRole('button', { name: 'Live log' }));
  expect(takeRequestedWorkerLogJob()).toBe('RQ-A');
  expect(pane.openPane).toHaveBeenLastCalledWith('worker-log');

  fireEvent.keyDown(open, { key: 'Escape' });
  await waitFor(() => expect(document.activeElement).toBe(card('RQ-A')));
  expect(screen.queryByRole('region', { name: 'Conversation with RQ-A' })).toBeNull();
});

it('offers no message to a finished session or a helper, and sends the leader to the Leader chat', async () => {
  serve(() => json(threads()), id => json(thread(id, { session: id === 'leader' ? threads().threads[0]!.session : threads().threads[3]!.session })));
  const pane = host();
  render(<SessionWallPane visible host={pane as never} />);
  fireEvent.click(await screen.findByRole('button', { name: 'RQ-DONE, done' }));
  await screen.findByRole('list', { name: 'Conversation with RQ-DONE' });
  expect(screen.queryByRole('button', { name: 'Write to it' })).toBeNull();
  expect(screen.getByRole('note').textContent).toBe('This session is not running, so there is nothing to steer. Write to the Leader in the Leader chat.');
  expect(screen.getByRole('link', { name: 'Pull request' }).getAttribute('href')).toBe('https://github.com/ashlrai/phantom/pull/9');
  fireEvent.click(screen.getByRole('button', { name: 'Back to every conversation' }));
  fireEvent.click(await screen.findByRole('button', { name: 'leader, idle' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Open the Leader chat' }));
  expect(pane.openPane).toHaveBeenLastCalledWith('leader-thread');
  expect(takeLeaderDraft()).toBe('');
  expect(screen.queryByRole('note')).toBeNull();
  expect(aimableJob(narrowSessionWall(threads())!.entries[2]!.session)).toBeNull();
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
  expect(narrowOpenThread(threads())).toBeNull();
  expect(narrowOpenThread({ schema: 'fleet.session-thread.v1', session: null })).toBeNull();
  const read = narrowSessionWall({ schema: 'fleet.session-threads.v1', counts: { sessions: 45 }, threads: [
    { session: { id: 'RQ-X', state: 'odd', prUrl: 'javascript:alert(1)', lastMessageAgeSeconds: -4 }, messageCount: 1, summary: ['ok', 7, ''],
      messages: [message('latest', 'session', 'RQ-X', 'one'), message('latest', 'session', 'RQ-X', 'duplicate key'), { key: 'bus:1' }, 7, message('bus:2', 'sideways', '', 'two', { at: 'never', format: 'html' })] },
    { session: { id: 'RQ-X' } }, { session: {} }, { summary: [] }, 7] })!;
  expect(read.entries).toHaveLength(1);
  expect(read.entries[0]!.session).toEqual({ id: 'RQ-X', kind: 'worker', lane: 'unknown', model: 'unknown', repo: 'unknown', jobId: null, parentId: null, state: 'unknown', lastMessageAgeSeconds: null, prUrl: null });
  expect(read.entries[0]).toMatchObject({ summary: ['ok'], messageCount: 2, messages: [{ key: 'latest', text: 'one', truncated: false }, { key: 'bus:2', side: 'record', label: 'Unlabelled', at: null, format: 'plain' }] });
  expect(wallHeadline(read)).toBe('1 of 45 sessions: 1 state unknown');
  expect(wallHeadline(narrowSessionWall(threads({ threads: [], counts: { sessions: 0 } }))!)).toBe('No agent sessions');
  render(<WallView read={narrowSessionWall(threads({ threads: [], counts: { sessions: 0 } }))!} onOpen={() => {}} />);
  expect(screen.getByRole('status').textContent).toBe('No agent sessions right now. Each one appears here as the fleet starts it.');
  expect(screen.queryByRole('group', { name: 'Show sessions by state' })).toBeNull();
});
