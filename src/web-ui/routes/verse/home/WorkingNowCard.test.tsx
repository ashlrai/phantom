import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildLiveSessions, type LiveSessionsV1 } from '../../../../core/fleet/live-sessions.js';
import type { FleetSessionV1 } from '../../../../core/fleet/runs-sessions.js';
import type { FleetSessionMap, MapSession } from '../../../../core/fleet/sessions-view.js';
import type { SubagentRecord } from '../../../../core/subagent/spawn.js';
import { narrowLiveSessions } from '../fleet-sessions/sessions-model.js';
import { mockViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { WORKING_NOW_LIMIT, WorkingNowCard, workingRows } from './WorkingNowCard.js';

const state = vi.hoisted(() => ({ read: { status: 'success', data: undefined as unknown, error: undefined as unknown } }));
vi.mock('../../../data/hooks.js', () => ({ useQuery: () => state.read, useRefetch: () => vi.fn() }));

const NOW = Date.parse('2026-11-17T12:00:00Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const local = (job: string, lane: string, over: Partial<FleetSessionV1> = {}) => ({ job, lane, repo: 'phantom', tier: 'frontier',
  model: 'fixture-model', startedAt: ago(30), lastOutputAt: ago(2), prUrl: null, ...over }) as FleetSessionV1;
const placed = (job: string, lane: string | null, over: Partial<MapSession> = {}): MapSession => ({
  job, lane, model: 'fixture-model', status: 'running', elapsedSeconds: 1800, prUrl: null, outcome: null, nodeId: 'node-here',
  placement: 'claim', mapState: 'running', branch: null, worktree: null, activity: null, detailSources: null, ...over });

/** The fixture is the core projection itself, read back through the pane's narrowing, so it matches what `phm sessions --json` prints. */
function fleet(jobs: FleetSessionV1[], extra: { recent?: FleetSessionV1[]; activity?: Record<string, string>; subagents?: SubagentRecord[] } = {}): LiveSessionsV1 {
  const map = { schema: 'fleet.sessions.v1', runsDirPresent: true, sourceState: 'healthy', sources: {}, truncated: false, localNodeId: 'node-here',
    sessions: jobs, mapSessions: jobs.map(job => placed(job.job, job.lane, { activity: extra.activity?.[job.job] ?? null })), recent: extra.recent ?? [] } as unknown as FleetSessionMap;
  return narrowLiveSessions(JSON.parse(JSON.stringify(buildLiveSessions(map, NOW, { subagents: extra.subagents ?? [] }))))!;
}
const helper = (id: string, parent_id: string) => ({ id, parent_id, depth: 1, lane: 'claude', model: 'small-model', state: 'running', created_at: ago(3) }) as SubagentRecord;
const BUSY = () => fleet(
  [local('RQ-A', 'claude'), local('RQ-QUIET', 'claude', { lastOutputAt: ago(14), startedAt: ago(40) }), local('RQ-B', 'codex-local', { lastOutputAt: ago(1) })],
  { recent: [local('RQ-FAILED', 'claude', { finishedAt: ago(5), outcome: 'failed' })], activity: { 'RQ-A': 'Running the tests' }, subagents: [helper('helper-a', 'RQ-A')] });

let viewport: ViewportMock | null = null;
const onOpenJob = vi.fn(), onOpenSessions = vi.fn();
const show = (data: unknown, width = 1440, status = 'success') => {
  viewport = mockViewport(width);
  state.read = { status, data, error: status === 'error' ? new Error('down') : undefined };
  render(<WorkingNowCard onOpenJob={onOpenJob} onOpenSessions={onOpenSessions} />);
  return within(screen.getByRole('region', { name: 'Working now' }));
};
beforeEach(() => { onOpenJob.mockClear(); onOpenSessions.mockClear(); });
afterEach(() => { cleanup(); viewport?.restore(); viewport = null; });

describe.each([['desktop width', 1440], ['390 px', 390]])('Working now at %s', (_name, width) => {
  it('lists each working session: the quiet one first, then the most recent, then the one that failed', () => {
    const card = show(BUSY(), width);
    // The leader's own state is not recorded, so the tree's line says so instead of counting it as running.
    expect(card.getByText('4 sessions running: 3 workers, 1 subagent; 1 failed in the last hour; 1 with state unknown · 1 quiet')).toBeTruthy();
    const rows = within(card.getByRole('list', { name: 'Sessions working now' })).getAllByRole('listitem');
    expect(rows.map(row => [row.querySelector('strong')?.textContent, row.getAttribute('data-state')])).toEqual([
      ['RQ-QUIET', 'quiet'], ['RQ-B', 'running'], ['RQ-A', 'running'], ['RQ-FAILED', 'failed']]);
    // The state is in words beside the mark, and each row carries its repo, when it last spoke and what it last said.
    expect(rows[0]!.textContent).toContain('quiet · spoke 14m ago');
    expect(rows[1]!.textContent).toContain('phantomspoke 1m ago');
    expect(rows[2]!.textContent).toContain('Running the tests');
    expect(rows[2]!.textContent).toContain('1 of 1 helpers running');
    expect(rows[3]!.textContent).toMatch(/failed · spoke 5m agoFailed/);
  });

  it('opens a session\'s messages from its row, and the whole tree from the one action', () => {
    const card = show(BUSY(), width);
    fireEvent.click(card.getByRole('button', { name: 'Open messages for RQ-QUIET, quiet' }));
    fireEvent.click(card.getByRole('button', { name: 'Open messages for RQ-A' }));
    expect(onOpenJob.mock.calls).toEqual([['RQ-QUIET'], ['RQ-A']]);
    fireEvent.click(card.getByRole('button', { name: 'Open Sessions' }));
    expect(onOpenSessions).toHaveBeenCalledTimes(1);
  });

  it('says so in plain words when nothing is running, with no rows', () => {
    const card = show(fleet([]), width);
    expect(card.getByText(/^No agent sessions running/)).toBeTruthy();
    expect(card.queryByRole('list', { name: 'Sessions working now' })).toBeNull();
    expect(card.getAllByRole('button').map(button => button.textContent)).toEqual(['Open Sessions']);
  });
});

it('shows a glance, and says how many more the Sessions pane holds', () => {
  const list = fleet(Array.from({ length: WORKING_NOW_LIMIT + 3 }, (_, i) => local(`RQ-${i}`, 'claude', { lastOutputAt: ago(i + 1) })));
  const card = show(list);
  expect(within(card.getByRole('list', { name: 'Sessions working now' })).getAllByRole('button')).toHaveLength(WORKING_NOW_LIMIT);
  expect(card.getByText('and 3 more in Sessions.')).toBeTruthy();
});

it('what the list does not hold reads unknown, never a made-up value', () => {
  const list = fleet([local('RQ-NOWORD', 'claude', { lastOutputAt: null, repo: null as never })]);
  const card = show(list);
  const row = card.getByRole('button', { name: 'Open messages for RQ-NOWORD' });
  expect(row.textContent).toContain('repo unknown');
  expect(row.textContent).toContain('last spoke unknown');
  expect(within(row).getByText('Last message unknown').hasAttribute('data-unknown')).toBe(true);
  // No output time means quiet is unknown, so the row is not marked quiet.
  expect(row.closest('li')!.getAttribute('data-state')).toBe('running');
  // The list's own gaps are named: the first in full, the rest counted.
  expect(list.gaps.length).toBeGreaterThan(0);
  expect(card.getByText(text => text.startsWith(`Unknown: ${list.gaps[0]}`)).hasAttribute('data-unknown')).toBe(true);
});

it('a failed refresh keeps the last list and says it may be stale; with no list it reads unknown', () => {
  let card = show(BUSY(), 1440, 'error');
  expect(card.getByRole('status').textContent).toBe('Could not refresh. Showing the last list, which may be stale.');
  expect(card.getByRole('button', { name: 'Open messages for RQ-A' })).toBeTruthy();
  cleanup();
  card = show(undefined, 1440, 'error');
  expect(card.getByRole('status').textContent).toBe('Unknown: the sessions could not be read.');
  expect(card.queryByText(/No agent sessions running/)).toBeNull();
  expect(card.getByRole('button', { name: 'Open Sessions' })).toBeTruthy();
});

it('stays hidden before the first read and for any other payload', () => {
  for (const data of [undefined, null, { schema: 'home.v1' }, { schema: 'fleet.live-sessions.v1' }, { error: 'not found' }]) {
    state.read = { status: 'success', data, error: undefined };
    render(<WorkingNowCard onOpenJob={onOpenJob} onOpenSessions={onOpenSessions} />);
    expect(screen.queryByRole('region', { name: 'Working now' })).toBeNull();
    cleanup();
  }
});

it('orders quiet, running, failed and leaves out the leader, subagents and finished work', () => {
  expect(workingRows(BUSY()).map(row => [row.node.id, row.quiet])).toEqual([['RQ-QUIET', true], ['RQ-B', false], ['RQ-A', false], ['RQ-FAILED', false]]);
  const done = fleet([], { recent: [local('RQ-DONE', 'claude', { finishedAt: ago(5), outcome: 'pr' })] });
  expect(workingRows(done)).toEqual([]);
});

it('every color and size the card names is a real design token, and it is one column at every width', () => {
  const read = (path: string) => readFileSync(join(process.cwd(), 'src/web-ui', path), 'utf8');
  const defined = new Set((read('design/tokens.css') + read('design/global.css')).match(/--[\w-]+(?=\s*:)/g));
  const css = read('routes/verse/home/working-now.module.css');
  expect([...new Set(css.match(/(?<=var\()--[\w-]+/g))].filter(name => !defined.has(name))).toEqual([]);
  expect(css).not.toMatch(/display:\s*grid|@media|min-width:\s*[1-9]/);
});
