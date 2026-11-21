import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { buildLiveSessions } from '../../../../core/fleet/live-sessions.js';
import type { FleetSessionMap } from '../../../../core/fleet/sessions-view.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { ApiError } from '../../../data/client.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { SessionsPane } from './SessionsPane.js';
import { SessionThread, SessionThreadView } from './SessionThread.js';
import { narrowSessionThread, replyRoute, replyText, routedRow, SESSION_THREAD_API, sourcesLine, threadFailure, THREAD_REPLY_MAX } from './session-thread-model.js';
import { LIVE_SESSIONS_API } from './sessions-model.js';
import { forgetThreadDrafts } from './thread-draft-store.js';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const INBOX = '/api/verse/leader/inbox';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

/** A fleet.session-thread.v1 body in the server's key order (core/fleet/session-thread.ts). */
function wire(over: Record<string, unknown> = {}, session: Record<string, unknown> = {}) {
  return {
    schema: 'fleet.session-thread.v1', generatedAt: ago(0), id: 'RQ-A',
    session: { id: 'RQ-A', kind: 'worker', agent: 'claude', lane: 'claude', model: 'fixture-model', repo: 'phantom', jobId: 'RQ-A', parentId: 'leader',
      state: 'running', startedAt: ago(30), ageSeconds: 1800, lastMessageAt: ago(2), lastMessageAgeSeconds: 120,
      prUrl: 'https://github.com/ashlrai/phantom/pull/9', computer: 'node-here', helpers: { below: 0, running: 0, failed: 0 }, ...session },
    summary: ['Worker on claude, fixture-model, in phantom.', 'Running for 30m; spoke 2m ago.', '3 commands seen, 2 files changed (+10 −4).'],
    messages: [
      { key: 'brief', kind: 'brief', side: 'other', label: 'Brief', at: null, text: 'Fix the **flaky** test.', format: 'markdown' },
      { key: 'step:0', kind: 'step', side: 'record', label: 'launched', at: ago(30), text: 'on claude', format: 'plain' },
      { key: 'commands', kind: 'commands', side: 'session', label: 'Ran 3 commands', at: null, text: 'npm ci\nnpx vitest run', format: 'mono' },
      { key: 'bus:m1', kind: 'bus', side: 'other', label: 'leader to RQ-A, steer', at: ago(5), text: 'Keep the diff small.', format: 'plain' },
      { key: 'bus:m1', kind: 'bus', side: 'other', label: 'duplicate key', at: ago(5), text: 'Dropped.', format: 'plain' },
      { key: 'latest', kind: 'latest', side: 'session', label: 'Latest', at: ago(2), text: 'Running the tests', format: 'plain' },
      { kind: 'bus', text: 'no key' }, 7,
    ],
    sources: { sessions: 'available', activity: 'available', bus: 'available', owner: 'none', replies: 'none', orders: 'none' },
    gaps: ['Older activity is outside the recorded window.'], ...over,
  };
}
const thread = (over?: Record<string, unknown>, session?: Record<string, unknown>) => narrowSessionThread(wire(over, session))!;

beforeEach(() => { evictAll(); forgetThreadDrafts(); setMutationToken('a'.repeat(64)); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); clearMutationToken(); });

describe('session thread model', () => {
  it('keeps the good messages, drops malformed and repeated ones, and refuses another schema', () => {
    const read = thread();
    expect(read.messages.map(m => m.key)).toEqual(['brief', 'step:0', 'commands', 'bus:m1', 'latest']);
    expect(read.session).toMatchObject({ id: 'RQ-A', state: 'running', jobId: 'RQ-A', prUrl: 'https://github.com/ashlrai/phantom/pull/9' });
    expect(narrowSessionThread({ ...wire(), schema: 'fleet.live-sessions.v1' })).toBeNull();
    expect(narrowSessionThread(wire({ session: null }))).toBeNull();
  });

  it('reads a malformed field as unknown and never links an off-site pull request', () => {
    const read = thread({ sources: {}, messages: [{ key: 'reply:0', side: 'sideways', label: 7, at: '19 Nov, morning', text: 'ok', format: 'html' }] },
      { state: 'sleeping', lane: 7, prUrl: 'javascript:alert(1)', lastMessageAgeSeconds: -4 });
    expect(read.session).toMatchObject({ state: 'unknown', lane: 'unknown', prUrl: null, lastMessageAgeSeconds: null });
    expect(read.messages[0]).toMatchObject({ side: 'record', label: 'Unlabelled', at: null, format: 'plain' });
    expect(sourcesLine(read)).toBe('Activity unknown · bus messages unknown · your messages unknown · routing unknown');
    expect(sourcesLine(thread({}, { kind: 'leader' }))).toBe('Activity shown · bus messages shown · your messages none recorded · replies to you none recorded · routing none recorded');
    expect(sourcesLine(thread({ sources: { activity: 'available', bus: 'none', owner: 'available', orders: 'available' } }, { kind: 'subagent' }))).toBe('Activity shown · bus messages none recorded · routing shown');
  });

  it('aims a reply at a running job, sends the Leader plain text, and sends nothing to a finished or jobless session', () => {
    const job = replyRoute(thread().session);
    expect(job).toMatchObject({ to: 'job', job: 'RQ-A' });
    expect(replyText(job, '  hold the tests \r\n')).toBe('@RQ-A hold the tests');
    expect(replyText(job, 'ask @RQ-A to stop')).toBe('ask @RQ-A to stop');
    expect(replyText(job, 'see @RQ-AB first')).toBe('@RQ-A see @RQ-AB first');
    expect(replyText(job, '   ')).toBeNull();
    expect(replyText(job, 'x'.repeat(THREAD_REPLY_MAX))).toBeNull();
    expect(replyRoute(thread({}, { state: 'quiet' }).session).to).toBe('job');
    const leader = replyRoute(thread({}, { kind: 'leader', jobId: null, state: 'idle' }).session);
    expect(leader.to).toBe('leader');
    expect(replyText(leader, 'What is running?')).toBe('What is running?');
    expect(replyRoute(thread({}, { state: 'done' }).session)).toMatchObject({ to: 'none', hint: expect.stringContaining('not running') });
    expect(replyRoute(thread({}, { kind: 'subagent', jobId: null }).session)).toMatchObject({ to: 'none', hint: expect.stringContaining('no job id') });
  });

  it('takes where a reply goes from the read, and never lets a body aim it at another session', () => {
    const hint = 'Goes to the Leader\'s inbox with @RQ-A in front, so the Leader knows which session you mean.';
    expect(thread({ reply: { to: 'job', mention: '@RQ-A', hint } }).reply).toEqual({ to: 'job', job: 'RQ-A', hint });
    // The server's "nothing can be sent" wins over what the session's fields suggest.
    expect(thread({ reply: { to: 'none', mention: null, hint: 'Held by the server.' } }).reply).toEqual({ to: 'none', hint: 'Held by the server.' });
    const local = replyRoute(thread().session);
    for (const reply of [{ to: 'job', mention: '@RQ-OTHER', hint }, { to: 'job', mention: 'RQ-A', hint }, { to: 'leader', mention: null, hint }, { to: 'job', mention: '@RQ-A' }, 'job', null]) {
      expect([reply, thread({ reply }).reply]).toEqual([reply, local]);
    }
    expect(thread({ reply: { to: 'leader', mention: null, hint: 'To the Leader.' } }, { kind: 'leader', jobId: null, state: 'idle' }).reply).toEqual({ to: 'leader', hint: 'To the Leader.' });
    expect(thread({}, { state: 'done' }).reply.to).toBe('none');
  });

  it('splits a routed job\'s pull request off its line only when it is a GitHub one', () => {
    expect(routedRow('RQ-B, on codex: merged https://github.com/ashlrai/phantom/pull/12')).toEqual({ text: 'RQ-B, on codex: merged', pr: 'https://github.com/ashlrai/phantom/pull/12' });
    expect(routedRow('RQ-C, lane unknown: queued')).toEqual({ text: 'RQ-C, lane unknown: queued', pr: null });
    expect(routedRow('RQ-D, on claude: published https://example.com/pull/3')).toEqual({ text: 'RQ-D, on claude: published https://example.com/pull/3', pr: null });
  });

  it('tells a session that left the list from a server without the read', () => {
    const fail = (status: number, detail: string | null) => threadFailure(new ApiError('x', status, SESSION_THREAD_API, detail));
    expect(fail(404, 'No session RQ-A in the list. Finished sessions stay for an hour.')).toEqual({ kind: 'gone', text: 'No session RQ-A in the list. Finished sessions stay for an hour.' });
    expect(fail(404, 'not found').kind).toBe('unsupported');
    expect(fail(404, null).text).toContain('Update Phantom');
    expect(fail(503, 'Sessions unavailable.').kind).toBe('unavailable');
    expect(threadFailure(new TypeError('offline')).text).toBe('The server did not answer. It retries every few seconds.');
  });
});

describe('session thread', () => {
  const open = (routes: Record<string, unknown>, post?: Parameters<typeof stubSurfaceFetch>[0] extends infer O ? O extends { post?: infer P } ? P : never : never) => {
    const net = stubSurfaceFetch({ routes, post });
    const onBack = vi.fn(), onOpenLog = vi.fn();
    render(<SessionThread id="RQ-A" visible onBack={onBack} onOpenLog={onOpenLog} />);
    return { net, onBack, onOpenLog };
  };

  it('shows the summary, who said what on which side, what is not shown, and the way back', async () => {
    const { net, onBack, onOpenLog } = open({ [SESSION_THREAD_API]: wire() });
    const summary = await screen.findByLabelText('Summary');
    for (const line of ['Worker on claude, fixture-model, in phantom.', 'Running for 30m; spoke 2m ago.']) expect(summary.textContent).toContain(line);
    expect(String(net.fetchMock.mock.calls[0]![0])).toBe(`${SESSION_THREAD_API}?id=RQ-A`);
    const items = within(screen.getByRole('list', { name: 'Conversation with RQ-A' })).getAllByRole('listitem');
    expect(items.map(item => item.getAttribute('data-side'))).toEqual(['other', 'record', 'session', 'other', 'session']);
    expect(items[1]!.textContent).toContain('launchedon claude');
    expect(items[2]!.querySelector('pre')?.textContent).toBe('npm ci\nnpx vitest run');
    expect(items[3]!.textContent).toContain('leader to RQ-A, steer');
    expect(items[4]!.textContent).toContain('Running the tests');
    const section = screen.getByRole('region', { name: 'Session RQ-A' });
    expect(section.querySelector('[data-state="running"]')?.textContent).toBe('running');
    expect(section.textContent).toContain('spoke 2m ago');
    expect(screen.getByText('Activity shown · bus messages shown · your messages none recorded · routing none recorded')).toBeTruthy();
    expect(within(screen.getByRole('list', { name: 'Not shown' })).getByText('Older activity is outside the recorded window.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Pull request' }).getAttribute('href')).toBe('https://github.com/ashlrai/phantom/pull/9');
    fireEvent.click(screen.getByRole('button', { name: 'Live log' }));
    expect(onOpenLog).toHaveBeenCalledWith('RQ-A');
    fireEvent.keyDown(section, { key: 'Escape' });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('sends a reply through the Leader inbox aimed at the job, and shows it as sent from here', async () => {
    const { net, onBack } = open({ [SESSION_THREAD_API]: wire() });
    const box = await screen.findByRole('textbox', { name: 'Message RQ-A' });
    expect(screen.getByText('Goes to the Leader\'s inbox with @RQ-A in front, so the Leader knows which session you mean.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty('disabled', true);
    fireEvent.change(box, { target: { value: 'hold the tests' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(onBack).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(net.posted).toHaveLength(0);
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(net.posted).toEqual([{ url: INBOX, body: { source: 'Phantom desktop', text: '@RQ-A hold the tests' } }]));
    await waitFor(() => expect(box).toHaveProperty('value', ''));
    const sent = within(screen.getByRole('list', { name: 'Conversation with RQ-A' })).getAllByRole('listitem').at(-1)!;
    expect(sent.getAttribute('data-kind')).toBe('sent');
    expect(sent.textContent).toContain('@RQ-A hold the tests');
    expect(sent.textContent).toContain('In the Leader\'s inbox.');
  });

  it('shows where a message was routed, one row per job, and drops the local copy of a sent message once the read holds it', async () => {
    let body = wire({ messages: [
      { key: 'order:desk-0', kind: 'order', side: 'other', label: 'Mason to the Leader, served by RQ-A, from desktop', at: ago(40), text: 'Fix the flaky test.', format: 'plain' },
      { key: 'routing:desk-0', kind: 'routing', side: 'record', label: 'Routed to 2 jobs', at: null, format: 'plain',
        text: 'RQ-A (this session), on claude: launched\nRQ-B, on codex: merged https://github.com/ashlrai/phantom/pull/12' },
    ], sources: { activity: 'none', bus: 'none', owner: 'none', replies: 'none', orders: 'available' } });
    const { net } = open({ [SESSION_THREAD_API]: () => json(body) });
    const log = await screen.findByRole('list', { name: 'Conversation with RQ-A' });
    const routing = log.querySelector('[data-kind="routing"]')!;
    expect(routing.textContent).toContain('Routed to 2 jobs');
    expect(within(routing as HTMLElement).getAllByRole('listitem').map(item => item.textContent)).toEqual(['RQ-A (this session), on claude: launched', 'RQ-B, on codex: merged PR #12']);
    expect(within(routing as HTMLElement).getByRole('link', { name: 'PR #12' }).getAttribute('href')).toBe('https://github.com/ashlrai/phantom/pull/12');
    expect(screen.getByText('Activity none recorded · bus messages none recorded · your messages none recorded · routing shown')).toBeTruthy();

    const box = screen.getByRole('textbox', { name: 'Message RQ-A' });
    fireEvent.change(box, { target: { value: 'hold the tests' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(net.posted).toHaveLength(1));
    expect(await screen.findByText(/In the Leader's inbox\./)).toBeTruthy();
    // The next read carries the inbox's own record of the message: one bubble, not two.
    body = wire({ messages: [{ key: 'owner:desk-1', kind: 'owner', side: 'other', label: 'Mason to the Leader, aimed at RQ-A', at: ago(0), text: '@RQ-A hold the tests', format: 'plain' }] });
    evictAll();
    cleanup();
    render(<SessionThreadView thread={narrowSessionThread(body)!} sent={[{ key: 'sent:1', at: ago(0), text: '@RQ-A hold the tests' }, { key: 'sent:2', at: ago(0), text: '@RQ-A and report back' }]} onSent={() => undefined} />);
    const items = within(screen.getByRole('list', { name: 'Conversation with RQ-A' })).getAllByRole('listitem');
    expect(items.map(item => item.getAttribute('data-kind'))).toEqual(['owner', 'sent']);
    expect(items[1]!.textContent).toContain('@RQ-A and report back');
  });

  it('asks for the token before sending, and keeps the words when the send is refused or held', async () => {
    clearMutationToken();
    let answer = json({ ok: false, status: 'drafted', error: 'Held: comms approval is not confirmed.' }, 403);
    const { net } = open({ [SESSION_THREAD_API]: wire() }, url => (url === INBOX ? answer : undefined));
    const box = await screen.findByRole('textbox', { name: 'Message RQ-A' });
    fireEvent.change(box, { target: { value: 'stop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unlock actions' });
    expect(dialog.textContent).toContain('Messaging a session requires the dispatch token.');
    expect(net.posted).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    setMutationToken('a'.repeat(64));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Not sent. Held: comms approval is not confirmed.');
    expect(box).toHaveProperty('value', 'stop');
    answer = json({ error: 'The inbox is full.' }, 500);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Not sent. The inbox is full.'));
    expect(screen.queryByText(/In the Leader's inbox/)).toBeNull();
  });

  it('offers no reply box for a finished session and says an empty conversation is empty', async () => {
    open({ [SESSION_THREAD_API]: wire({ messages: [], summary: [], sources: { activity: 'none', bus: 'unavailable', owner: 'none', replies: 'none', orders: 'none' } }, { state: 'failed', prUrl: null, lastMessageAgeSeconds: null }) });
    expect((await screen.findByText('Nothing is recorded for RQ-A yet.')).getAttribute('role')).toBe('status');
    expect(screen.getByText('Summary unknown: the read returned none.')).toBeTruthy();
    expect(screen.getByText('Activity none recorded · bus messages unknown · your messages none recorded · routing none recorded')).toBeTruthy();
    expect(screen.getByRole('note').textContent).toContain('This session is not running');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('region', { name: 'Session RQ-A' }).textContent).toContain('failedlast spoke unknown');
  });

  it('says so when the server cannot read conversations, when the session left the list, and when the read fails', async () => {
    const first = open({ [SESSION_THREAD_API]: null });
    expect((await screen.findByRole('alert')).textContent).toContain('cannot read a session as a conversation yet');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back to all sessions' }));
    expect(first.onBack).toHaveBeenCalled();
    cleanup(); evictAll();

    open({ [SESSION_THREAD_API]: () => json({ error: 'No session RQ-A in the list. Finished sessions stay for an hour.' }, 404) });
    expect((await screen.findByRole('alert')).textContent).toContain('No session RQ-A in the list.');
    cleanup(); evictAll();

    let calls = 0;
    open({ [SESSION_THREAD_API]: () => (calls++ === 0 ? json({ error: 'Sessions unavailable.' }, 503) : json(wire())) });
    expect((await screen.findByRole('alert')).textContent).toContain('The session list could not be read just now.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByLabelText('Summary')).toBeTruthy();
    cleanup(); evictAll();

    open({ [SESSION_THREAD_API]: { schema: 'something.else' } });
    expect((await screen.findByRole('alert')).textContent).toBe('The server answered with something that is not a session conversation.');
  });
});

it('opens a session as a conversation from its row in the Sessions pane and returns with Back', async () => {
  const map = { schema: 'fleet.sessions.v1', runsDirPresent: true, sourceState: 'healthy', sources: {}, truncated: false, localNodeId: 'node-here',
    sessions: [{ job: 'RQ-A', lane: 'claude', repo: 'phantom', tier: 'frontier', model: 'fixture-model', startedAt: ago(30), lastOutputAt: ago(2), prUrl: null }],
    mapSessions: [{ job: 'RQ-A', lane: 'claude', model: 'fixture-model', status: 'running', elapsedSeconds: 1800, prUrl: null, outcome: null, nodeId: 'node-here',
      placement: 'claim', mapState: 'running', branch: null, worktree: null, activity: 'Running the tests', detailSources: null }] } as unknown as FleetSessionMap;
  const net = stubSurfaceFetch({ routes: { [LIVE_SESSIONS_API]: buildLiveSessions(map, NOW), [SESSION_THREAD_API]: wire() } });
  const openPane = vi.fn();
  render(<SessionsPane visible host={{ openPane } as never} />);
  expect(await screen.findByRole('button', { name: 'Read leader as a conversation' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Read RQ-A as a conversation' }));
  expect(await screen.findByLabelText('Summary')).toBeTruthy();
  expect(screen.queryByRole('list', { name: 'Session tree' })).toBeNull();
  expect(net.fetchMock.mock.calls.some(([url]) => String(url) === `${SESSION_THREAD_API}?id=RQ-A`)).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Live log' }));
  expect(openPane).toHaveBeenCalledWith('worker-log');
  fireEvent.click(screen.getByRole('button', { name: 'Back to all sessions' }));
  expect(screen.getByRole('list', { name: 'Session tree' })).toBeTruthy();
});
