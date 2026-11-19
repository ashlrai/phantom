import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { resetWorkerLogSelection, takeRequestedWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { takeRequestedWallSession } from '../session-wall/wall-selection.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';

/** The wall-clock string MASON-INBOX.md writes ("YYYY-MM-DD HH:MM" in America/New_York). */
const etWall = (ms: number) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(ms).replace(',', '');

const MIN = 60_000;
const PR = 'https://github.com/ashlrai/phantom/pull/4321';
const ORDER = 'ship the judge fix first';

const fleetRuns = (at: string) => ({
  v: 1, generatedAt: new Date().toISOString(),
  sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'missing', merges: 'healthy' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
  host: null, lanes: [], workers: [], claimed: [], leaders: [], orchestratorAgents: null,
  publishesLastHour: [], mergesLastHour: { count: null, items: [] }, events: [], codexPersonal: null,
  inbox: [{ at, source: 'Phantom desktop', text: ORDER }], outbox: [], drop: null,
});

const orderTrace = (at: string, jobs: unknown[], prompts = 'healthy') => ({
  v: 1, generatedAt: new Date().toISOString(), sources: { inbox: 'healthy', prompts, publishes: 'healthy' },
  orders: [{ at, source: 'Phantom desktop', key: at.slice(5), jobs }],
});

function serve(at: string, orders: unknown) {
  return stubSurfaceFetch({ routes: {
    '/api/verse/leader/directives': { directives: [] },
    '/api/verse/leader/thread': { messages: [msg({ id: 'lead-1' })] },
    '/api/verse/fleet/runs': fleetRuns(at),
    '/api/verse/leader/orders': orders,
  } });
}

beforeEach(() => { evictAll(); clearMutationToken(); });
afterEach(() => { vi.unstubAllGlobals(); clearMutationToken(); resetWorkerLogSelection(); takeRequestedWallSession(); });

describe('Leader thread routing trail', () => {
  it('shows the lanes and jobs a message was routed to, with the PR link and the worker log', async () => {
    const at = etWall(Date.now() - 10 * MIN);
    serve(at, orderTrace(at, [
      { id: 'RQ-PHX-JUDGE', lane: 'devin', state: 'merged', url: PR },
      { id: 'RQ-PHX-JUDGE2', lane: 'codex-personal', state: 'launched', url: null },
      { id: 'RQ-PHX-JUDGE3', lane: null, state: 'queued', url: null },
    ]));
    render(<LeaderThreadPane visible />);
    const log = screen.getByRole('log', { name: 'Conversation with the Leader' });
    const trail = await within(log).findByRole('group', { name: 'Routing: 3 jobs · 2 lanes · 1 merged · 1 launched · 1 queued' });
    const rows = within(trail).getAllByRole('listitem');
    expect(rows.map(row => row.getAttribute('data-state'))).toEqual(['merged', 'launched', 'queued']);
    expect(within(rows[0]!).getByText('devin')).toBeInTheDocument();
    expect(within(rows[0]!).getByRole('link', { name: 'merged #4321' })).toHaveAttribute('href', PR);
    expect(within(rows[2]!).getByText('lane unknown')).toBeInTheDocument();
    // A queued job has no worker log yet, so its id is not a button.
    expect(within(rows[2]!).queryByRole('button')).not.toBeInTheDocument();
    // The trail sits under the words it routes.
    expect(within(log).getByText(ORDER).compareDocumentPosition(trail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('2 routed jobs in flight')).toBeInTheDocument();

    fireEvent.click(within(rows[1]!).getByRole('button', { name: 'Open log for RQ-PHX-JUDGE2' }));
    expect(takeRequestedWorkerLogJob()).toBe('RQ-PHX-JUDGE2');

    // A launched or finished job has a session to read as a conversation; the request is for that job only.
    expect(within(rows[0]!).getByRole('button', { name: 'Open conversation with RQ-PHX-JUDGE' })).toBeInTheDocument();
    fireEvent.click(within(rows[1]!).getByRole('button', { name: 'Open conversation with RQ-PHX-JUDGE2' }));
    expect(takeRequestedWallSession()).toBe('RQ-PHX-JUDGE2');
    expect(takeRequestedWallSession()).toBeNull();
  });

  it('folds a long fan-out behind "Show more"', async () => {
    const at = etWall(Date.now() - 10 * MIN);
    serve(at, orderTrace(at, Array.from({ length: 6 }, (_, index) => ({ id: `RQ-FAN-${index}`, lane: 'devin', state: 'launched', url: null }))));
    render(<LeaderThreadPane visible />);
    const trail = await screen.findByRole('group', { name: /^Routing: 6 jobs/ });
    expect(within(trail).getAllByRole('listitem')).toHaveLength(4);
    fireEvent.click(within(trail).getByRole('button', { name: 'Show 2 more' }));
    expect(within(trail).getAllByRole('listitem')).toHaveLength(6);
  });

  it('says a fresh message no job cites is not routed yet', async () => {
    const at = etWall(Date.now() - 10 * MIN);
    serve(at, orderTrace(at, []));
    render(<LeaderThreadPane visible />);
    const line = await screen.findByText('Not routed to a lane yet');
    expect(line.parentElement).toHaveAttribute('data-routing', 'unrouted');
    expect(screen.queryByText(/routed jobs? in flight/)).not.toBeInTheDocument();
  });

  it('says routing is unknown when the prompt journals could not be read', async () => {
    const at = etWall(Date.now() - 10 * MIN);
    serve(at, orderTrace(at, [], 'degraded'));
    render(<LeaderThreadPane visible />);
    expect((await screen.findByText('Routing unknown: job prompts could not be read')).parentElement).toHaveAttribute('data-routing', 'unknown');
  });

  it('labels the thread when the order trace does not answer, and invents no routing', async () => {
    const at = etWall(Date.now() - 10 * MIN);
    serve(at, null);
    render(<LeaderThreadPane visible />);
    const log = screen.getByRole('log', { name: 'Conversation with the Leader' });
    expect(await within(log).findByText(ORDER)).toBeInTheDocument();
    expect(await screen.findByText('Routing unavailable')).toBeInTheDocument();
    expect(log.querySelector('[data-routing]')).toBeNull();
  });
});
