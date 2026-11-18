import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { buildLiveSessions, type LiveSessionsV1 } from '../../../../core/fleet/live-sessions.js';
import type { FleetSessionMap, MapSession } from '../../../../core/fleet/sessions-view.js';
import type { FleetSessionV1 } from '../../../../core/fleet/runs-sessions.js';
import type { SubagentRecord } from '../../../../core/subagent/spawn.js';
import { evictAll } from '../../../data/cache.js';
import { getPane } from '../panes/pane-registry.js';
import { mockViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { takeRequestedWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { SessionsPane, SessionsView } from './SessionsPane.js';
import { narrowLiveSessions, sessionsHeadline } from './sessions-model.js';
import './fleet-sessions.pane.js';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const local = (job: string, lane: string, over: Partial<FleetSessionV1> = {}) => ({ job, lane, repo: 'phantom', tier: 'frontier',
  model: 'fixture-model', startedAt: ago(30), lastOutputAt: ago(2), prUrl: null, ...over }) as FleetSessionV1;
const placed = (job: string, lane: string | null, nodeId: string | null, over: Partial<MapSession> = {}): MapSession => ({
  job, lane, model: 'fixture-model', status: 'running', elapsedSeconds: 1800, prUrl: null, outcome: null, nodeId,
  placement: nodeId ? 'claim' : 'unknown', mapState: 'running', branch: null, worktree: null, activity: null, detailSources: null, ...over });

/** The pane's fixture is the core projection itself, so the JSON matches what `phm sessions --json` prints. */
function fleet(): LiveSessionsV1 {
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
  return buildLiveSessions(map, NOW, { subagents: [helper('helper-a', 'RQ-A'), helper('helper-lost', 'RQ-GONE')] });
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
