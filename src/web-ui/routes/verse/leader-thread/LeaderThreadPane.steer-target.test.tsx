import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';

/** The wall-clock string MASON-INBOX.md writes ("YYYY-MM-DD HH:MM" in America/New_York). */
const etWall = (ms: number) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(ms).replace(',', '');

const MIN = 60_000;
const JOB = 'RQ-PHX-FIX';
const PR = 'https://github.com/ashlrai/phantom/pull/4321';

const fleetRuns = (now: number, overrides: Record<string, unknown> = {}) => ({
  v: 1, generatedAt: new Date(now).toISOString(),
  sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'missing', merges: 'healthy' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
  host: null, lanes: [], workers: [], claimed: [], leaders: [], orchestratorAgents: null,
  publishesLastHour: [], mergesLastHour: { count: null, items: [] }, events: [], codexPersonal: null,
  inbox: [{ at: etWall(now - 10 * MIN), source: 'Phantom desktop', text: `steer @${JOB} on the recut, then report back` }],
  outbox: [], drop: null, ...overrides,
});

const jobDetail = (state: string, prUrl: string | null) => ({
  schema: 'fleet.job.v1', generatedAt: '2026-11-10T15:00:00Z', job: JOB, state,
  lane: 'devin', requestedLane: null, launchedLane: null, laneReason: null, tier: 'mid', model: 'm',
  pid: null, launchedAt: '2026-11-10T14:30:00Z', baseSha: 'a1b2c3d', branch: `bridge/${JOB}`, promptBytes: 10,
  publish: prUrl === null ? { prUrl: null, autoMerge: null, testLine: null, sensitive: null } : { prUrl, autoMerge: true, testLine: null, sensitive: null },
  notes: { hasNotes: false, hasBody: false, notesBytes: null },
  log: { source: 'missing', bytes: null, tail: [], truncated: false },
  sources: { launch: 'healthy', base: 'healthy', meta: 'healthy', publish: 'healthy', log: 'missing' },
});

const orderTrace = (state: string, url: string | null) => ({
  v: 1, generatedAt: '2026-11-10T15:00:00Z', sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' },
  orders: [{ at: '2026-11-10 09:56', source: 'Phantom desktop', key: '11-10 09:56', jobs: [{ id: JOB, lane: 'devin', state, url }] }],
});

function serve(routes: NonNullable<Parameters<typeof stubSurfaceFetch>[0]>['routes']) {
  return stubSurfaceFetch({ routes: { '/api/verse/leader/directives': { directives: [] }, '/api/verse/leader/thread': { messages: [msg({ id: 'lead-1' })] }, ...routes } });
}

beforeEach(() => { evictAll(); clearMutationToken(); });
afterEach(() => { vi.unstubAllGlobals(); clearMutationToken(); });

describe('Leader thread steer-target outcome', () => {
  it('shows the merged follow-up line with a PR link under the targeted entry', async () => {
    const now = Date.now();
    serve({
      '/api/verse/fleet/runs': fleetRuns(now),
      '/api/verse/leader/orders': orderTrace('merged', PR),
      '/api/fleet/job': jobDetail('published', PR),
    });
    render(<LeaderThreadPane visible />);
    const log = screen.getByRole('log', { name: 'Conversation with the Leader' });
    expect(await within(log).findByText(`steer @${JOB} on the recut, then report back`)).toBeInTheDocument();
    const link = await within(log).findByRole('link', { name: `${JOB} merged as #4321` });
    expect(link).toHaveAttribute('href', PR);
    expect(link.parentElement).toHaveAttribute('data-steer-outcome', 'merged');
  });

  it('says no outcome is recorded when the job has none', async () => {
    const now = Date.now();
    serve({
      '/api/verse/fleet/runs': fleetRuns(now),
      '/api/verse/leader/orders': { v: 1, generatedAt: '2026-11-10T15:00:00Z', sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' }, orders: [] },
      '/api/fleet/job': jobDetail('unknown', null),
    });
    render(<LeaderThreadPane visible />);
    const log = screen.getByRole('log', { name: 'Conversation with the Leader' });
    const line = await within(log).findByText(`${JOB}: no outcome recorded yet`);
    expect(line).toHaveAttribute('data-steer-outcome', 'unknown');
    expect(within(log).queryByRole('link', { name: new RegExp(JOB) })).not.toBeInTheDocument();
  });

  it('shows no outcome line for an entry that names no target', async () => {
    const now = Date.now();
    const fixture = fleetRuns(now);
    fixture.inbox = [{ at: etWall(now - 10 * MIN), source: 'Phantom desktop', text: 'ship the judge fix first' }];
    serve({ '/api/verse/fleet/runs': fixture, '/api/verse/leader/orders': orderTrace('merged', PR), '/api/fleet/job': jobDetail('published', PR) });
    render(<LeaderThreadPane visible />);
    const log = screen.getByRole('log', { name: 'Conversation with the Leader' });
    expect(await within(log).findByText('ship the judge fix first')).toBeInTheDocument();
    expect(log.querySelector('[data-steer-outcome]')).toBeNull();
  });
});
