import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { buildLiveSessions, type LiveSessionsV1 } from '../../../../core/fleet/live-sessions.js';
import type { FleetSessionMap, MapSession } from '../../../../core/fleet/sessions-view.js';
import type { FleetSessionV1 } from '../../../../core/fleet/runs-sessions.js';
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
  } as unknown as FleetSessionMap;
  return buildLiveSessions(map, NOW);
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
  it('groups sessions by lane, highlights quiet ones and shows every unknown with its reason', () => {
    viewport = mockViewport(width);
    const list = narrowLiveSessions(JSON.parse(JSON.stringify(fleet())))!;
    render(<SessionsView list={list} onOpen={() => {}} />);
    expect(screen.getByText('4 running · 1 quiet · 3 lanes · 1 on another computer')).toBeTruthy();
    const lanes = screen.getAllByRole('region').filter(region => region.getAttribute('aria-label')?.startsWith('Lane '));
    expect(lanes.map(region => region.getAttribute('aria-label'))).toEqual(['Lane claude', 'Lane codex-local', 'Lane unknown']);
    const claude = within(lanes[0]!);
    expect(claude.getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['Open log for RQ-QUIET, quiet', 'Open log for RQ-A']);
    const quiet = claude.getByRole('button', { name: 'Open log for RQ-QUIET, quiet' }).closest('li')!;
    expect(quiet.getAttribute('data-quiet')).toBe('true');
    expect(quiet.textContent).toContain('output 14m ago');
    expect(claude.getByRole('button', { name: 'Open log for RQ-A' }).closest('li')!.getAttribute('data-quiet')).toBeNull();
    const noModel = within(lanes[1]!).getByRole('button', { name: 'Open log for RQ-NOMODEL' });
    expect(noModel.textContent).toContain('unknown');
    expect(noModel.textContent).toContain('model unknown: no launch record or model file names a model yet');
    expect(within(lanes[1]!).getByRole('link', { name: 'Pull request for RQ-NOMODEL' }).getAttribute('href')).toBe('https://github.com/ashlrai/phantom/pull/9');
    const far = within(lanes[2]!).getByRole('button', { name: 'Open log for RQ-FAR' });
    expect(far.textContent).toContain('node-far');
    expect(far.textContent).toContain('model unknown: it runs on another computer');
    expect(screen.getByText('phm sessions --json')).toBeTruthy();
  });

  it('shows the empty state in plain words', () => {
    viewport = mockViewport(width);
    render(<SessionsView list={narrowLiveSessions(JSON.parse(JSON.stringify(empty())))!} onOpen={() => {}} />);
    expect(screen.getByRole('status').textContent).toBe('No agent sessions running.');
    expect(screen.getByText('0 running · 0 quiet · 0 lanes')).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});

it('opens the existing worker log (live tail with pause and stop) for the session clicked', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify(fleet()), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetch);
  const openPane = vi.fn();
  render(<SessionsPane visible host={{ openPane } as never} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open log for RQ-QUIET, quiet' }));
  expect(openPane).toHaveBeenCalledWith('worker-log');
  expect(takeRequestedWorkerLogJob()).toBe('RQ-QUIET');
  expect(String((fetch.mock.calls[0] as unknown[])[0])).toContain('/api/verse/fleet/control/live-sessions');
});

it('reads an unexpected payload as unavailable and drops malformed rows', async () => {
  expect(narrowLiveSessions({ schema: 'fleet.live-map.v1', sessions: [] })).toBeNull();
  const list = narrowLiveSessions({ schema: 'fleet.live-sessions.v1', sessions: [{ job: 'RQ-X', prUrl: 'javascript:alert(1)', quiet: 'yes' }, { lane: 'claude' }, 7] })!;
  expect(list.sessions).toHaveLength(1);
  expect(list.sessions[0]).toMatchObject({ job: 'RQ-X', lane: 'unknown', model: 'unknown', prUrl: null, quiet: null, computer: 'unknown' });
  expect(sessionsHeadline(list)).toBe('1 running · 0 quiet · 1 lane');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ schema: 'other' }), { status: 200, headers: { 'content-type': 'application/json' } })));
  render(<SessionsPane visible host={{ openPane: vi.fn() } as never} />);
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Sessions unavailable'));
});
