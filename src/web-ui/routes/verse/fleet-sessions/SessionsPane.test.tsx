import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { buildLiveSessions, type LiveSessionsV1 } from '../../../../core/fleet/live-sessions.js';
import type { FleetSessionMap, MapSession } from '../../../../core/fleet/sessions-view.js';
import type { FleetSessionV1 } from '../../../../core/fleet/runs-sessions.js';
import type { LeaderSessionFacts } from '../../../../core/fleet/session-tree.js';
import type { SubagentRecord } from '../../../../core/subagent/spawn.js';
import { evictAll } from '../../../data/cache.js';
import { getPane } from '../panes/pane-registry.js';
import { mockViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { takeRequestedWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { SessionsPane, SessionsView } from './SessionsPane.js';
import { filterSessionTree, narrowLiveSessions, sessionScopeCounts, sessionsHeadline } from './sessions-model.js';
import './fleet-sessions.pane.js';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const local = (job: string, lane: string, over: Partial<FleetSessionV1> = {}) => ({ job, lane, repo: 'phantom', tier: 'frontier',
  model: 'fixture-model', startedAt: ago(30), lastOutputAt: ago(2), prUrl: null, ...over }) as FleetSessionV1;
const placed = (job: string, lane: string | null, nodeId: string | null, over: Partial<MapSession> = {}): MapSession => ({
  job, lane, model: 'fixture-model', status: 'running', elapsedSeconds: 1800, prUrl: null, outcome: null, nodeId,
  placement: nodeId ? 'claim' : 'unknown', mapState: 'running', branch: null, worktree: null, activity: null, detailSources: null, ...over });

/** The pane's fixture is the core projection itself, so the JSON matches what `phm sessions --json` prints. */
function fleet(leader?: LeaderSessionFacts): LiveSessionsV1 {
  const map = {
    schema: 'fleet.sessions.v1', runsDirPresent: true, sourceState: 'healthy', sources: {}, truncated: false, localNodeId: 'node-here',
    sessions: [local('RQ-A', 'claude'), local('RQ-QUIET', 'claude', { lastOutputAt: ago(14), startedAt: ago(40) }),
      local('RQ-NOMODEL', 'codex-local', { model: null, prUrl: 'https://github.com/ashlrai/phantom/pull/9' })],
    mapSessions: [placed('RQ-A', 'claude', 'node-here'), placed('RQ-QUIET', 'claude', 'node-here'),
      placed('RQ-NOMODEL', 'codex-local', 'node-here', { model: null }), placed('RQ-FAR', null, 'node-far', { model: null, status: 'unknown' })],
    recent: [local('RQ-FAILED', 'claude', { finishedAt: ago(5), outcome: 'failed' })],
  } as unknown as FleetSessionMap;
  map.mapSessions[0]!.activity = 'Running the tests';
  const helper = (id: string, parent_id: string) => ({ id, parent_id, depth: 1, lane: 'claude', model: 'small-model', state: 'running', created_at: ago(3) }) as SubagentRecord;
  return buildLiveSessions(map, NOW, { subagents: [helper('helper-a', 'RQ-A'), helper('helper-lost', 'RQ-GONE')], leader });
}
const empty = (): LiveSessionsV1 => buildLiveSessions({ schema: 'fleet.sessions.v1', runsDirPresent: true, sourceState: 'healthy', sources: {},
  truncated: false, localNodeId: 'node-here', sessions: [], mapSessions: [] } as unknown as FleetSessionMap, NOW);

let viewport: ViewportMock | null = null;
beforeEach(() => { evictAll(); });
afterEach(() => { cleanup(); viewport?.restore(); viewport = null; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('registers a session-independent Sessions pane', () => {
  expect(getPane('fleet-sessions')).toMatchObject({ id: 'fleet-sessions', title: 'Sessions', needsSession: false });
});

describe.each([['desktop width', 1440], ['390 px', 390]])('Sessions at %s', (_name, width) => {
  it('shows the tree: leader, workers, subagents, a failed session and an unknown parent, each with its last message', () => {
    viewport = mockViewport(width);
    const list = narrowLiveSessions(JSON.parse(JSON.stringify(fleet())))!;
    render(<SessionsView list={list} onOpen={() => {}} />);
    expect(screen.getByText('5 sessions running: 3 workers, 2 subagents; 1 failed in the last hour; 2 with state unknown; 1 under unknown parent · 1 quiet · 1 on another computer')).toBeTruthy();
    const rows = within(screen.getByRole('list', { name: 'Session tree' })).getAllByRole('listitem');
    expect(rows.map(row => [row.querySelector('strong')?.textContent ?? row.textContent, row.style.marginLeft.match(/\d/)?.[0]])).toEqual([
      ['leader', '0'], ['RQ-A', '1'], ['helper-a', '2'], ['RQ-NOMODEL', '1'], ['RQ-QUIET', '1'], ['RQ-FAILED', '1'], ['RQ-FAR', '1'],
      ['Unknown parent 1', '0'], ['helper-lost', '1']]);
    expect(rows[0]!.textContent).toContain('state unknown');
    expect(rows[0]!.textContent).toContain('4 of 6 below running');
    expect(rows[0]!.textContent).toContain('Last message unknown');
    expect(rows[0]!.querySelector('button')).toBeNull();
    const worker = screen.getByRole('button', { name: 'Open messages for RQ-A' });
    for (const fact of ['fixture-model', 'phantom', 'spoke 2m ago', 'Running the tests', 'this computer', '1 of 1 below running']) expect(worker.textContent).toContain(fact);
    expect(rows[2]!.textContent).toContain('subagentsmall-modelphantomlast spoke unknown');
    const quiet = screen.getByRole('button', { name: 'Open messages for RQ-QUIET, quiet' }).closest('li')!;
    expect(quiet.getAttribute('data-quiet')).toBe('true');
    expect(quiet.textContent).toContain('spoke 14m ago');
    expect(worker.closest('li')!.getAttribute('data-quiet')).toBeNull();
    const failed = screen.getByRole('button', { name: 'Open messages for RQ-FAILED' });
    expect(failed.querySelector('[data-state="failed"]')?.textContent).toBe('failed');
    expect(failed.textContent).toContain('Failed');
    const noModel = screen.getByRole('button', { name: 'Open messages for RQ-NOMODEL' });
    expect(noModel.textContent).toContain('model unknown: no launch record or model file names a model yet');
    expect(screen.getByRole('link', { name: 'Pull request for RQ-NOMODEL' }).getAttribute('href')).toBe('https://github.com/ashlrai/phantom/pull/9');
    const far = screen.getByRole('button', { name: 'Open messages for RQ-FAR' });
    expect(far.textContent).toContain('node-far');
    expect(far.textContent).toContain('model unknown: it runs on another computer');
    expect(screen.getByText('Leader state, model and messages unknown: no source records the leader session yet.')).toBeTruthy();
    expect(screen.getByText('phm sessions --json')).toBeTruthy();
  });

  it('shows the empty state in plain words', () => {
    viewport = mockViewport(width);
    render(<SessionsView list={narrowLiveSessions(JSON.parse(JSON.stringify(empty())))!} onOpen={() => {}} />);
    expect(screen.getByRole('status').textContent).toBe('No agent sessions running.');
    expect(screen.getAllByText('No agent sessions running.')).toHaveLength(2);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});

describe('narrowing the tree', () => {
  const list = () => narrowLiveSessions(JSON.parse(JSON.stringify(fleet())))!;
  const shown = () => within(screen.getByRole('list', { name: 'Session tree' })).getAllByRole('listitem')
    .map(row => `${row.querySelector('strong')?.textContent ?? row.textContent}${row.getAttribute('data-context') ? ' (context)' : ''}`);

  it('counts every scope from the tree itself and keeps a match under its parent', () => {
    expect(sessionScopeCounts(list())).toEqual({ all: 8, running: 5, quiet: 1, failed: 1 });
    expect(sessionScopeCounts(narrowLiveSessions(JSON.parse(JSON.stringify(empty())))!)).toEqual({ all: 0, running: 0, quiet: 0, failed: 0 });
    const helpers = filterSessionTree(list(), 'all', '  HELPER small-model ');
    expect(helpers.matches).toBe(2);
    expect(helpers.rows.map(row => [row.node.id, row.depth, row.context])).toEqual([
      ['leader', 0, true], ['RQ-A', 1, true], ['helper-a', 2, false], ['unknown parent', 0, false], ['helper-lost', 1, false]]);
    expect(filterSessionTree(list(), 'failed', 'helper')).toEqual({ rows: [], matches: 0 });
    expect(filterSessionTree(list(), 'all', '').matches).toBe(8);
  });

  it('narrows by scope and by typed words, says how many are shown, and restores the full tree', () => {
    render(<SessionsView list={list()} onOpen={() => {}} />);
    const scopes = within(screen.getByRole('radiogroup', { name: 'Show sessions' }));
    expect(scopes.getAllByRole('radio').map(option => option.getAttribute('aria-label'))).toEqual([
      'All, 8 sessions', 'Running, 5 sessions', 'Quiet, 1 session', 'Failed, 1 session']);
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(scopes.getByRole('radio', { name: 'Failed, 1 session' }));
    expect(shown()).toEqual(['leader (context)', 'RQ-FAILED']);
    expect(screen.getByRole('status').textContent).toContain('Showing 1 of 8 sessions.');
    fireEvent.click(scopes.getByRole('radio', { name: 'Quiet, 1 session' }));
    expect(shown()).toEqual(['leader (context)', 'RQ-QUIET']);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter sessions' }), { target: { value: 'no-such-session' } });
    expect(screen.queryByRole('list', { name: 'Session tree' })).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('No sessions match.');
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(shown()).toHaveLength(9);
    expect(screen.queryByRole('status')).toBeNull();
    expect((screen.getByRole('searchbox', { name: 'Filter sessions' }) as HTMLInputElement).value).toBe('');
  });

  it('is driven from the keyboard: / to filter, arrows or j k to move, Esc to clear', () => {
    const onOpen = vi.fn();
    render(<SessionsView list={list()} onOpen={onOpen} />);
    const box = screen.getByRole('searchbox', { name: 'Filter sessions' }) as HTMLInputElement;
    const open = (id: string) => screen.getByRole('button', { name: new RegExp(`^Open messages for ${id}`) });
    fireEvent.keyDown(open('RQ-A'), { key: '/' });
    expect(document.activeElement).toBe(box);
    fireEvent.keyDown(box, { key: 'j' });
    expect(document.activeElement).toBe(box);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(open('RQ-A'));
    fireEvent.keyDown(open('RQ-A'), { key: 'j' });
    expect(document.activeElement).toBe(open('RQ-NOMODEL'));
    fireEvent.keyDown(open('RQ-NOMODEL'), { key: 'End' });
    expect(document.activeElement).toBe(open('RQ-FAR'));
    fireEvent.keyDown(open('RQ-FAR'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(open('RQ-FAR'));
    fireEvent.keyDown(open('RQ-FAR'), { key: 'Home' });
    fireEvent.keyDown(open('RQ-A'), { key: 'k', metaKey: true });
    expect(document.activeElement).toBe(open('RQ-A'));
    fireEvent.keyDown(open('RQ-A'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: 'quiet' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(box.value).toBe('');
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('keeps leader navigation and conversation actions on filtered context rows', () => {
    const onOpenLeader = vi.fn(), onThread = vi.fn(), onOpen = vi.fn();
    render(<SessionsView list={list()} onOpen={onOpen} onOpenLeader={onOpenLeader} onThread={onThread} />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter sessions' }), { target: { value: 'RQ-QUIET' } });
    const leader = screen.getByRole('button', { name: 'Open the Leader chat' });
    expect(leader.closest('li')?.getAttribute('data-context')).toBe('true');
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(leader);
    fireEvent.click(leader);
    expect(onOpenLeader).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Read RQ-QUIET as a conversation' }));
    expect(onThread).toHaveBeenCalledWith('RQ-QUIET');
    fireEvent.click(screen.getByRole('button', { name: 'Open messages for RQ-QUIET, quiet' }));
    expect(onOpen).toHaveBeenCalledWith('RQ-QUIET');
  });
});

it('opens the session clicked in the existing worker log (its messages, with pause and stop)', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify(fleet()), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetch);
  const openPane = vi.fn();
  render(<SessionsPane visible host={{ openPane } as never} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open messages for RQ-QUIET, quiet' }));
  expect(openPane).toHaveBeenCalledWith('worker-log');
  expect(takeRequestedWorkerLogJob()).toBe('RQ-QUIET');
  expect(String((fetch.mock.calls[0] as unknown[])[0])).toContain('/api/verse/fleet/control/live-sessions');
});

it('shows the leader between passes with its last reply, and opens the Leader chat from its row', async () => {
  const list = fleet({ lastPassAt: ago(4), lastReplyAt: ago(6), lastReply: 'Routed the desk work\nto two lanes.' });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(list), { status: 200, headers: { 'content-type': 'application/json' } })));
  const openPane = vi.fn();
  render(<SessionsPane visible host={{ openPane } as never} />);
  const row = await screen.findByRole('button', { name: 'Open the Leader chat' });
  expect(row.querySelector('[data-state="idle"]')?.textContent).toBe('idle');
  for (const fact of ['leader', 'model unknown', 'spoke 6m ago', 'Routed the desk work to two lanes.', '4 of 6 below running']) expect(row.textContent).toContain(fact);
  expect(screen.getByText(/^5 sessions running: 3 workers, 2 subagents; 1 failed in the last hour; 1 with state unknown; 1 under unknown parent/)).toBeTruthy();
  expect(within(screen.getByRole('list', { name: 'Unknown' })).getAllByRole('listitem').map(item => item.textContent)).toEqual(['Leader model unknown: no source records the model its passes run on.']);
  fireEvent.click(row);
  expect(openPane).toHaveBeenCalledWith('leader-thread');
  expect(takeRequestedWorkerLogJob()).toBeNull();
});

it('keeps the leader row plain when its state is unknown and nothing can open', () => {
  render(<SessionsView list={narrowLiveSessions(JSON.parse(JSON.stringify(fleet({ lastPassAt: ago(200), lastReplyAt: null, lastReply: null }))))!} onOpen={() => {}} />);
  expect(screen.queryByRole('button', { name: 'Open the Leader chat' })).toBeNull();
  expect(screen.getByText('Leader state unknown: its last recorded pass ended 3h 20m ago.')).toBeTruthy();
  expect(screen.getByText('Leader messages unknown: no reply to you is recorded yet.')).toBeTruthy();
});

it('reads an unexpected payload as unavailable and drops malformed rows', async () => {
  expect(narrowLiveSessions({ schema: 'fleet.live-map.v1', sessions: [] })).toBeNull();
  const list = narrowLiveSessions({ schema: 'fleet.live-sessions.v1', sessions: [{ job: 'RQ-X', prUrl: 'javascript:alert(1)', quiet: 'yes' }, { lane: 'claude' }, 7] })!;
  expect(list.sessions).toHaveLength(1);
  expect(list.sessions[0]).toMatchObject({ job: 'RQ-X', lane: 'unknown', model: 'unknown', prUrl: null, quiet: null, computer: 'unknown' });
  expect(sessionsHeadline(list)).toBe('No agent sessions running.');
  const tree = narrowLiveSessions({ schema: 'fleet.live-sessions.v1', sessions: [], tree: { line: 'made up', counts: { running: 99 }, roots: [
    { id: 'leader', state: 'running', kind: 'boss', children: [{ id: 'worker-a', parentId: 'leader', state: 'odd', lastMessageAt: 'never' }, 7, { parentId: 'leader' }] }] } })!.tree;
  expect(tree.line).toBe('1 session running: leader; 1 with state unknown');
  expect(tree.roots[0]).toMatchObject({ kind: 'leader', counts: { below: 1, running: 0 }, children: [{ id: 'worker-a', kind: 'worker', state: 'unknown', lastMessageAt: null, model: 'unknown' }] });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ schema: 'other' }), { status: 200, headers: { 'content-type': 'application/json' } })));
  render(<SessionsPane visible host={{ openPane: vi.fn() } as never} />);
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Sessions unavailable'));
});
