import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { buildLiveSessions, type LiveSessionsV1 } from '../../../../core/fleet/live-sessions.js';
import type { FleetSessionV1 } from '../../../../core/fleet/runs-sessions.js';
import type { FleetSessionMap, MapSession } from '../../../../core/fleet/sessions-view.js';
import type { SubagentRecord } from '../../../../core/subagent/spawn.js';
import { evictAll } from '../../../data/cache.js';
import { takeRequestedWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { narrowLiveSessions } from '../fleet-sessions/sessions-model.js';
import { getPane, shortcutProblem } from '../panes/pane-registry.js';
import { DISCOVERED_PANE_MODULES } from '../panes/index.js';
import { AgentThreadsPane } from './AgentThreadsPane.js';
import { agentThreads, stepThread, threadBubbles, threadSummary } from './agent-threads-model.js';
import './agent-threads.pane.js';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const local = (job: string, lane: string, over: Partial<FleetSessionV1> = {}) => ({ job, lane, repo: 'phantom', tier: 'frontier',
  model: 'fixture-model', startedAt: ago(30), lastOutputAt: ago(2), prUrl: null, ...over }) as FleetSessionV1;
const placed = (job: string, lane: string | null, activity: string | null = null): MapSession => ({
  job, lane, model: 'fixture-model', status: 'running', elapsedSeconds: 1800, prUrl: null, outcome: null, nodeId: 'node-here',
  placement: 'claim', mapState: 'running', branch: null, worktree: null, activity, detailSources: null });

/** The fixture is the core projection itself, so the JSON matches what `phm sessions --json` prints. */
function fleet(jobs: FleetSessionV1[] = [local('RQ-A', 'claude', { prUrl: 'https://github.com/ashlrai/phantom/pull/9' }),
  local('RQ-QUIET', 'claude', { lastOutputAt: ago(14), startedAt: ago(40) })]): LiveSessionsV1 {
  const map = { schema: 'fleet.sessions.v1', runsDirPresent: true, sourceState: 'healthy', sources: {}, truncated: false, localNodeId: 'node-here',
    sessions: jobs, mapSessions: jobs.map(job => placed(job.job, job.lane, job.job === 'RQ-A' ? 'Running the tests' : null)),
    recent: jobs.length ? [local('RQ-FAILED', 'claude', { finishedAt: ago(5), outcome: 'failed' })] : [] } as unknown as FleetSessionMap;
  const helper = { id: 'helper-a', parent_id: 'RQ-A', depth: 1, lane: 'claude', model: 'small-model', state: 'running', created_at: ago(3) } as SubagentRecord;
  return buildLiveSessions(map, NOW, { subagents: jobs.length ? [helper] : [] });
}
const ACTIVITY = {
  schema: 'fleet.job.activity.v1', job: 'RQ-A', state: 'running', counts: { events: 1, commands: 2, files: 1, reports: 2 }, truncated: false,
  entries: [
    { kind: 'event', at: '2026-11-17T11:30:05Z', event: 'launched', summary: 'on claude' },
    { kind: 'command', text: 'npm test', line: 4 }, { kind: 'command', text: 'git status', line: 9 },
    { kind: 'files', state: 'live', baseSha: 'abc1234', files: [{ path: 'src/a.ts', added: 12, removed: 3, status: 'modified' }], totals: { files: 1, added: 12, removed: 3 }, truncated: false },
    { kind: 'report', name: 'notes', state: 'missing', source: null, bytes: null, truncated: false, text: '' },
    { kind: 'report', name: 'brief', state: 'ok', source: 'body', bytes: 20, truncated: false, text: 'Fix the flaky test' },
  ],
};
const MESSAGES = { schema: 'agent-messages.v1', source: 'available', matched: 2, skipped: 0, messages: [
  { id: 'm2', ts: '2026-11-17T11:50:00Z', from: { name: 'RQ-A', lane: 'claude' }, to: { name: 'leader', lane: null }, kind: 'status', summary: 'Tests are green', conversation: 'c1', job: 'RQ-A', pr: null },
  { id: 'm1', ts: '2026-11-17T11:40:00Z', from: { name: 'leader', lane: null }, to: { name: 'RQ-A', lane: 'claude' }, kind: 'ask', summary: 'How far along?', conversation: 'c1', job: 'RQ-A', pr: null },
  { id: 'm0', ts: '2026-11-17T11:45:00Z', from: { name: 'RQ-Z', lane: 'codex' }, to: { name: 'leader', lane: null }, kind: 'status', summary: 'Someone else', conversation: 'c2', job: 'RQ-Z', pr: null },
] };
const REPLIES = { schema: 'leader.replies.v1', version: 1, sourceState: 'healthy', entries: [],
  replies: [{ at: '2026-11-17 06:55', text: 'Routed the flaky test to claude.', source: 'plan-log' }] };

function serve(routes: Record<string, unknown>) {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const hit = Object.keys(routes).find(path => String(input).includes(path));
    return hit === undefined ? new Response(null, { status: 404 }) : Response.json(routes[hit]);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const LIVE = { '/control/live-sessions': fleet(), '/api/fleet/job/activity?id=RQ-A': ACTIVITY, '/agent-bus/messages': MESSAGES, '/runs/leader-replies': REPLIES };
const openPane = vi.fn();
const show = () => render(<AgentThreadsPane visible host={{ openPane } as never} />);
const threadNames = () => within(screen.getByRole('list', { name: 'Threads' })).getAllByRole('button').map(row => row.querySelector('strong')!.textContent);

beforeEach(() => { evictAll(); openPane.mockClear(); serve(LIVE); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('registers a session-independent Agent threads pane with a free key, grouped under Chat', () => {
  expect(Object.keys(DISCOVERED_PANE_MODULES)).toContain('../agent-threads/agent-threads.pane.tsx');
  expect(getPane('agent-threads')).toMatchObject({ id: 'agent-threads', title: 'Agent threads', needsSession: false });
  expect(getPane('agent-threads')!.shortcut).toMatchObject({ key: 'a', mod: true, alt: true });
  expect(shortcutProblem('mod+alt+a', 'agent-threads')).toBeNull();
});

it('lists every session as a thread: the leader first, then quiet, running and failed, each with its state and last message', async () => {
  show();
  expect(screen.getByRole('status').textContent).toBe('Reading sessions…');
  await screen.findByRole('list', { name: 'Threads' });
  expect(threadNames()).toEqual(['leader', 'RQ-QUIET', 'RQ-A', 'helper-a', 'RQ-FAILED']);
  const quiet = screen.getByRole('button', { name: 'RQ-QUIET, quiet, spoke 14m ago' });
  expect(quiet.getAttribute('data-state')).toBe('quiet');
  expect(quiet.textContent).toContain('worker · claude · phantom');
  expect(screen.getByRole('button', { name: /^RQ-A, running/ }).textContent).toContain('Running the tests');
  expect(screen.getByRole('button', { name: /^helper-a, running/ }).textContent).toContain('helps RQ-A');
  expect(screen.getByRole('button', { name: /^RQ-FAILED, failed/ }).querySelector('[data-state="failed"]')!.textContent).toContain('failed · spoke 5m ago');
  // The leader's own state is not recorded: it says so, and its thread is its newest replies with a way into the Leader chat.
  const leader = screen.getByRole('button', { name: /^leader, state unknown/ });
  expect(leader.getAttribute('aria-current')).toBe('true');
  expect(leader.textContent).toContain('Last message unknown');
  const thread = within(screen.getByRole('region', { name: 'Thread with leader' }));
  expect(await thread.findByText('Routed the flaky test to claude.')).toBeTruthy();
  expect(thread.getByText('2026-11-17 06:55 ET')).toBeTruthy();
  fireEvent.click(thread.getByRole('button', { name: 'Open Leader chat' }));
  expect(openPane).toHaveBeenCalledWith('leader-thread');
});

it('opens a session as a conversation with a summary from its records, and Enter opens its full log', async () => {
  const fetch = serve(LIVE);
  show();
  fireEvent.click(await screen.findByRole('button', { name: /^RQ-A, running/ }));
  const thread = within(screen.getByRole('region', { name: 'Thread with RQ-A' }));
  await thread.findByText('Fix the flaky test');
  expect(within(thread.getByLabelText('Summary')).getAllByRole('listitem').map(line => line.textContent)).toEqual([
    'Worker on claude, fixture-model, in phantom.', 'Running for 30m; spoke 2m ago.', '1 of 1 helper running.',
    '2 commands seen, 1 file changed (+12 −3).', 'Latest step: launched on claude at 11:30:05.']);
  const bubbles = within(thread.getByRole('log', { name: 'Messages with RQ-A' })).getAllByRole('listitem');
  expect(bubbles.map(bubble => [bubble.getAttribute('data-side'), bubble.querySelector('strong')!.textContent])).toEqual([
    ['other', 'Brief'], ['system', 'launched'], ['agent', 'Ran 2 commands'], ['agent', 'Changed 1 file · +12 −3'],
    ['other', 'leader → RQ-A · ask'], ['agent', 'RQ-A → leader · status'], ['agent', 'Latest']]);
  expect(bubbles[2]!.querySelector('pre')!.textContent).toBe('npm test\ngit status');
  expect(bubbles[4]!.textContent).toContain('How far along?');
  expect(thread.queryByText('Someone else')).toBeNull();
  expect(thread.getByRole('link', { name: 'Pull request' }).getAttribute('href')).toBe('https://github.com/ashlrai/phantom/pull/9');
  expect(fetch.mock.calls.some(([url]) => String(url).includes('/api/fleet/job/activity?id=RQ-A'))).toBe(true);
  // Keyboard: J moves to the next thread, K back, Enter opens the selected session's full log.
  const row = screen.getByRole('button', { name: /^RQ-A, running/ });
  fireEvent.keyDown(row, { key: 'j' });
  expect(screen.getByRole('button', { name: /^helper-a/ }).getAttribute('aria-current')).toBe('true');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: /^helper-a/ }));
  fireEvent.keyDown(document.activeElement!, { key: 'k' });
  fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
  expect(openPane).toHaveBeenCalledWith('worker-log');
  expect(takeRequestedWorkerLogJob()).toBe('RQ-A');
});

it('filters the list, and says so when nothing matches or nothing is running', async () => {
  show();
  const filter = await screen.findByRole('searchbox', { name: 'Filter sessions' });
  fireEvent.change(filter, { target: { value: 'quiet' } });
  expect(threadNames()).toEqual(['RQ-QUIET']);
  expect(screen.getByRole('region', { name: 'Thread with RQ-QUIET' })).toBeTruthy();
  fireEvent.change(filter, { target: { value: 'nothing-here' } });
  expect(screen.getByText('No session matches “nothing-here”.')).toBeTruthy();
  fireEvent.keyDown(filter, { key: 'Escape' });
  expect(threadNames()).toHaveLength(5);
  cleanup(); evictAll();
  serve({ '/control/live-sessions': fleet([]) });
  show();
  // An empty fleet says so once, with no rows, and the thread side explains what will appear.
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('No agent sessions running.'));
  expect(screen.queryByRole('list', { name: 'Threads' })).toBeNull();
  expect(screen.getByText('Each session gets a thread here as soon as it starts.')).toBeTruthy();
});

it('keeps unknown as unknown: no activity, no bus and an unreadable list are each said in words', async () => {
  serve({ '/control/live-sessions': fleet() });
  show();
  fireEvent.click(await screen.findByRole('button', { name: /^RQ-QUIET/ }));
  const thread = within(screen.getByRole('region', { name: 'Thread with RQ-QUIET' }));
  expect(await thread.findByText('No activity is recorded for this session.')).toBeTruthy();
  expect(thread.getByText('Quiet: no output for 14m.')).toBeTruthy();
  expect(await thread.findByText('Bus messages unavailable.')).toBeTruthy();
  cleanup(); evictAll();
  serve({ '/control/live-sessions': { schema: 'something-else' } });
  show();
  expect(await screen.findByText('Sessions unavailable right now. It retries every few seconds.')).toBeTruthy();
});

it('builds threads from the records alone', () => {
  const threads = agentThreads(narrowLiveSessions(JSON.parse(JSON.stringify(fleet())))!);
  const helper = threads.find(thread => thread.node.id === 'helper-a')!;
  expect(helper.parent).toBe('RQ-A');
  expect(threadSummary(helper, null)).toEqual(['Helper on claude, small-model, in phantom.', 'Running for unknown; last spoke unknown.', 'No activity is recorded for this session.']);
  // Still reading: the summary says nothing about activity instead of guessing.
  expect(threadSummary(helper, undefined)).toHaveLength(2);
  expect(threadBubbles(helper, null, [])).toEqual([]);
  const many = { schema: 'fleet.job.activity.v1' as const, truncated: true, counts: { commands: null },
    entries: Array.from({ length: 11 }, (_, line) => ({ kind: 'command' as const, text: `step ${line}`, line })) };
  const ran = threadBubbles(threads[2]!, many, [])[0]!;
  expect(ran.label).toBe('Ran 11 commands · last 8 shown');
  expect(ran.text.split('\n')).toEqual(['step 3', 'step 4', 'step 5', 'step 6', 'step 7', 'step 8', 'step 9', 'step 10']);
  expect(threadSummary(threads[2]!, many).slice(-2)).toEqual(['Commands unknown, changed files unknown.', 'Older activity is outside the recorded window.']);
  expect(stepThread(threads, 'RQ-FAILED', 1)).toBe('leader');
  expect(stepThread(threads, null, -1)).toBe('leader');
  expect(stepThread([], 'leader', 1)).toBeNull();
});
