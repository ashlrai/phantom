import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { buildLiveSessions, type LiveSessionsV1 } from '../../../../core/fleet/live-sessions.js';
import type { FleetSessionV1 } from '../../../../core/fleet/runs-sessions.js';
import type { FleetSessionMap, MapSession } from '../../../../core/fleet/sessions-view.js';
import { evictAll } from '../../../data/cache.js';
import { narrowLiveSessions } from '../fleet-sessions/sessions-model.js';
import { getPane, type PaneProps } from '../panes/pane-registry.js';
import { COMPUTER_JOBS_LIMIT, ComputersBody, ComputersPane, runningLine } from './ComputersPane.js';
import { narrowComputers } from './computers-model.js';
import './computers.pane.js';

const GIB = 1024 ** 3;
const row = (name: string, o: Record<string, unknown> = {}) => ({
  name, isSelf: false, reachable: true, lastSeen: '2026-11-17T12:00:00.000Z', phantom: 'running', freeMemoryBytes: 12 * GIB,
  cpuHeadroomPercent: 75, lanes: ['claude', 'codex'], jobsRunning: [], freeSlots: 2, stateCode: 'ready', state: 'ready for work', ...o });
const payload = (nodes: unknown[], reasons: string[] = []) => ({ v: 1, schemaVersion: 1, asOf: '2026-11-17T12:00:00.000Z', self: 'node-a', registry: 'pool-witness', nodes, reasons });
const UNKNOWN = { freeMemoryBytes: 'unknown', cpuHeadroomPercent: 'unknown', lanes: 'unknown', jobsRunning: 'unknown', freeSlots: 'unknown' };

const NOW = Date.parse('2026-11-17T12:00:00Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const local = (job: string, over: Partial<FleetSessionV1> = {}) => ({ job, lane: 'claude', repo: 'phantom', tier: 'frontier',
  model: 'fixture-model', startedAt: ago(30), lastOutputAt: ago(2), prUrl: null, ...over }) as FleetSessionV1;
/** The sessions fixture is the core projection itself, read back through the pane's narrowing, so it matches `phm sessions --json`. */
function sessionsOf(jobs: FleetSessionV1[], activity: Record<string, string> = {}): LiveSessionsV1 {
  const placed = (job: FleetSessionV1): MapSession => ({ job: job.job, lane: job.lane, model: 'fixture-model', status: 'running', elapsedSeconds: 1800, prUrl: null,
    outcome: null, nodeId: 'node-a', placement: 'claim', mapState: 'running', branch: null, worktree: null, activity: activity[job.job] ?? null, detailSources: null });
  const map = { schema: 'fleet.sessions.v1', runsDirPresent: true, sourceState: 'healthy', sources: {}, truncated: false, localNodeId: 'node-a',
    sessions: jobs, mapSessions: jobs.map(placed), recent: [] } as unknown as FleetSessionMap;
  return narrowLiveSessions(JSON.parse(JSON.stringify(buildLiveSessions(map, NOW, { subagents: [] }))))!;
}
const BUSY = () => sessionsOf([local('RQ-A'), local('RQ-QUIET', { lastOutputAt: ago(14), startedAt: ago(40) })], { 'RQ-A': 'Running the tests' });

beforeEach(() => { evictAll(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('renders one card per computer with the server state words', () => {
  render(<ComputersBody view={narrowComputers(payload([
    row('node-a', { isSelf: true, jobsRunning: ['job-1'] }),
    row('node-b', { ...UNKNOWN, reachable: false, phantom: 'not-running', stateCode: 'offline', state: 'offline since 10:42' }),
    row('node-c', { ...UNKNOWN, phantom: 'not-running', stateCode: 'not-running', state: 'reachable but Phantom not running: run `phm node join` there' }),
  ]))} />);
  expect(screen.getByText('1 of 3 ready for work')).toBeTruthy();
  expect(screen.getAllByRole('listitem')).toHaveLength(3);
  const self = within(screen.getByRole('listitem', { name: 'node-a' }));
  expect(self.getByText('· this computer')).toBeTruthy();
  expect(self.getByText('ready for work')).toBeTruthy();
  expect(self.getByText('12.0 GB')).toBeTruthy();
  expect(self.getByText('75%')).toBeTruthy();
  expect(self.getByText('claude, codex')).toBeTruthy();
  expect(self.getByText('1')).toBeTruthy();
  const offline = screen.getByRole('listitem', { name: 'node-b' });
  expect(offline.getAttribute('data-state')).toBe('offline');
  expect(within(offline).getByText('offline since 10:42')).toBeTruthy();
  expect(within(offline).getAllByText('unknown')).toHaveLength(4);
  expect(within(screen.getByRole('listitem', { name: 'node-c' })).getByText('reachable but Phantom not running: run `phm node join` there')).toBeTruthy();
  expect(screen.queryByText(/your only computer/)).toBeNull();
});

it('single computer: one card, how to add another, and the reason', () => {
  render(<ComputersBody view={narrowComputers(payload(
    [row('node-a', { ...UNKNOWN, isSelf: true, phantom: 'not-running', stateCode: 'not-running', state: 'reachable but Phantom not running: run `phm node join` here', freeMemoryBytes: 8 * GIB })],
    ['tailscale unavailable or status unreadable']))} />);
  expect(screen.getAllByRole('listitem')).toHaveLength(1);
  expect(screen.getByText('0 of 1 ready for work')).toBeTruthy();
  expect(screen.getByText(/This is your only computer so far/)).toBeTruthy();
  expect(screen.getByText('phm node join')).toBeTruthy();
  expect(screen.getByText('tailscale unavailable or status unreadable')).toBeTruthy();
});

it('narrow drops malformed rows and never invents a state', () => {
  expect(narrowComputers(null)).toBeNull();
  expect(narrowComputers({ nodes: 'x' })).toBeNull();
  const view = narrowComputers(payload(['junk', { state: 'ready for work' }, { name: 'node-x', stateCode: 'great', state: 'ready for work', freeMemoryBytes: -1, lanes: 'claude' }]));
  expect(view?.computers).toEqual([{ name: 'node-x', isSelf: false, stateCode: 'unknown', state: 'unknown',
    freeMemoryBytes: 'unknown', cpuHeadroomPercent: 'unknown', lanes: 'unknown', jobsRunning: 'unknown', jobs: 'unknown', freeSlots: 'unknown' }]);
});

it('registers a Computers pane that loads the cards from the API', async () => {
  expect(getPane('fleet-computers')).toMatchObject({ title: 'Computers', needsSession: false });
  const fetch = vi.fn(async (_url: string) => Response.json(payload([row('node-a', { isSelf: true }), row('node-b')])));
  vi.stubGlobal('fetch', fetch);
  render(<ComputersPane visible />);
  expect(await screen.findByText('2 of 2 ready for work')).toBeTruthy();
  expect(String(fetch.mock.calls[0]?.[0])).toContain('/api/verse/fleet/runtime-identity/nodes');
  // Nothing is running, so there is nothing to describe: the sessions list is not asked for.
  expect(fetch.mock.calls.some(([url]) => String(url).includes('live-sessions'))).toBe(false);
});

it('says so plainly when the list cannot be read', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
  render(<ComputersPane visible />);
  expect(await screen.findByText('Computers are unavailable right now.')).toBeTruthy();
});

it('lists what each computer is running, with each job\'s repo, when it last spoke and its last message', () => {
  const onOpenJob = vi.fn();
  render(<ComputersBody onOpenJob={onOpenJob} sessions={BUSY()} view={narrowComputers(payload([
    row('node-a', { isSelf: true, jobsRunning: ['RQ-A', 'RQ-GHOST', 'RQ-QUIET'], freeSlots: 1 }),
    row('node-b', { ...UNKNOWN, stateCode: 'unknown', state: 'reachable; Phantom status unknown' }),
    row('node-c'),
  ]))} />);
  // Only computers whose claims are known are counted, and the one that is not is named.
  expect(screen.getByText('3 jobs running on 1 computer; unknown for 1 computer.')).toBeTruthy();
  const here = within(screen.getByRole('listitem', { name: 'node-a' }));
  expect(here.getByText('3 running, 1 free slot')).toBeTruthy();
  expect(here.getByRole('meter', { name: 'node-a job slots in use' })).toBeTruthy();
  const jobs = within(here.getByRole('group', { name: 'Running on node-a' }));
  const active = jobs.getByRole('button', { name: 'Open messages for RQ-A' });
  expect(active.textContent).toContain('phantom');
  expect(active.textContent).toContain('spoke 2m ago');
  expect(active.textContent).toContain('Running the tests');
  // Quiet is said in words beside the mark, and in the button's name.
  const quiet = jobs.getByRole('button', { name: 'Open messages for RQ-QUIET, quiet' });
  expect(quiet.textContent).toContain('quiet · spoke 14m ago');
  expect(quiet.getAttribute('data-state')).toBe('quiet');
  // A job the sessions list does not hold says so; it never borrows a repo or a message.
  const ghost = jobs.getByRole('button', { name: 'Open messages for RQ-GHOST' });
  expect(ghost.textContent).toBe('RQ-GHOSTNo session record for this job on this computer.');
  fireEvent.click(quiet);
  fireEvent.click(ghost);
  expect(onOpenJob.mock.calls).toEqual([['RQ-QUIET'], ['RQ-GHOST']]);
  // Unknown claims: no list and no bar. Known and idle: a bar at nothing running, and no list.
  const unknown = within(screen.getByRole('listitem', { name: 'node-b' }));
  expect(unknown.queryByRole('group')).toBeNull();
  expect(unknown.queryByRole('meter')).toBeNull();
  const idle = within(screen.getByRole('listitem', { name: 'node-c' }));
  expect(idle.getByText('0 running, 2 free slots')).toBeTruthy();
  expect(idle.queryByRole('group')).toBeNull();
});

it('keeps the job ids when the sessions list is missing, and says why the details are', () => {
  const view = narrowComputers(payload([row('node-a', { jobsRunning: ['RQ-A'], freeSlots: 'unknown' })]));
  // Not read yet: the id alone, nothing claimed about it.
  const { rerender } = render(<ComputersBody view={view} onOpenJob={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Open messages for RQ-A' }).textContent).toBe('RQ-A');
  // Free slots unknown: the words that need them are left out and no bar is drawn.
  expect(screen.queryByRole('meter')).toBeNull();
  expect(screen.queryByText(/free slot/)).toBeNull();
  rerender(<ComputersBody view={view} sessions={null} onOpenJob={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Open messages for RQ-A' }).textContent).toBe('RQ-ASession details unknown: the sessions list could not be read.');
  // A failed refresh keeps the last details and says they may be stale.
  rerender(<ComputersBody view={view} sessions={BUSY()} sessionsStale onOpenJob={vi.fn()} />);
  expect(screen.getByRole('status').textContent).toBe('Could not refresh the sessions list. Job details below are from the last read and may be stale.');
  expect(screen.getByRole('button', { name: 'Open messages for RQ-A' }).textContent).toContain('Running the tests');
});

it('shows a glance per computer, opens Sessions for the rest, and makes no button of an id the server would refuse', () => {
  const onOpenSessions = vi.fn();
  const ids = Array.from({ length: COMPUTER_JOBS_LIMIT + 2 }, (_, i) => `RQ-${i}`);
  render(<ComputersBody onOpenJob={vi.fn()} onOpenSessions={onOpenSessions} view={narrowComputers(payload([
    row('node-a', { jobsRunning: ids, freeSlots: 0, stateCode: 'busy', state: 'busy: 8 jobs running, no free slots' }),
    row('node-b', { jobsRunning: ['not an id'] }),
  ]))} />);
  const here = within(screen.getByRole('listitem', { name: 'node-a' }));
  expect(here.getByText('8 running, no free slots')).toBeTruthy();
  expect(here.getAllByRole('button', { name: /^Open messages for/ })).toHaveLength(COMPUTER_JOBS_LIMIT);
  fireEvent.click(here.getByRole('button', { name: 'and 2 more in Sessions' }));
  expect(onOpenSessions).toHaveBeenCalledTimes(1);
  const other = within(screen.getByRole('listitem', { name: 'node-b' }));
  expect(other.getByText('not an id')).toBeTruthy();
  expect(other.queryByRole('button')).toBeNull();
});

it('the running line counts only what is known', () => {
  const cards = (nodes: unknown[]) => narrowComputers(payload(nodes))!.computers;
  expect(runningLine(cards([row('a'), row('b')]))).toBe('No jobs running.');
  expect(runningLine(cards([row('a', { jobsRunning: ['RQ-1'] }), row('b', { jobsRunning: ['RQ-2', 'RQ-3'] })]))).toBe('3 jobs running on 2 computers.');
  expect(runningLine(cards([row('a', UNKNOWN), row('b', UNKNOWN)]))).toBe('Jobs running: unknown.');
  expect(runningLine(cards([row('a'), row('b', UNKNOWN)]))).toBe('No jobs running; unknown for 1 computer.');
  // No slots at all (a held computer) draws no bar: an empty one would read as idle.
  render(<ComputersBody view={narrowComputers(payload([row('a', { freeSlots: 0, stateCode: 'held', state: 'holding: no job slots open' })]))} />);
  expect(screen.queryByRole('meter')).toBeNull();
});

it('the pane reads the sessions list once a computer has a job, and opens that job in the Worker log', async () => {
  const fetch = vi.fn(async (url: string) => String(url).includes('live-sessions')
    ? Response.json(JSON.parse(JSON.stringify(BUSY())))
    : Response.json(payload([row('node-a', { isSelf: true, jobsRunning: ['RQ-A'] })])));
  vi.stubGlobal('fetch', fetch);
  const openPane = vi.fn();
  render(<ComputersPane visible host={{ openPane } as unknown as PaneProps['host']} />);
  const job = await screen.findByRole('button', { name: 'Open messages for RQ-A' });
  expect((await screen.findByText('Running the tests'))).toBeTruthy();
  expect(String(fetch.mock.calls[0]?.[0])).toContain('/api/verse/fleet/runtime-identity/nodes');
  fireEvent.click(job);
  expect(openPane.mock.calls).toEqual([['worker-log']]);
});

it('every color and size the job rows name is a real design token', () => {
  const read = (path: string) => readFileSync(join(process.cwd(), 'src/web-ui', path), 'utf8');
  const defined = new Set((read('design/tokens.css') + read('design/global.css')).match(/--[\w-]+(?=\s*:)/g));
  const css = read('routes/verse/fleet-host/fleet-host.module.css');
  const rows = css.slice(css.indexOf('/* Computers: what each computer is running.'));
  expect(rows.length).toBeGreaterThan(100);
  expect([...new Set(rows.match(/(?<=var\()--[\w-]+/g))].filter(name => !defined.has(name))).toEqual([]);
});
