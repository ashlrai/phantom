/**
 * Teammate-task ledger selectors: `imessage-tasks list`, MCP
 * `fleet_imessage_tasks` and the Verse teammate-tasks API all validate the
 * same bounded peer/state/kind values and AND them with the job selector
 * through one shared match rule — exact matches on stored fields only.
 *
 * Hermetic: temp runs roots and injected readers; no transport, queue or
 * provider calls.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const send = vi.hoisted(() => vi.fn());
vi.mock('../src/core/web/api.js', () => ({ sendJson: send }));

import { cmdFleetImessageTasks } from '../src/cli/fleet-imessage-tasks.js';
import { cmdFleetTeammateTasks } from '../src/cli/fleet-teammate-tasks.js';
import { listTeammateTasks, teammateTaskLedgerMatch } from '../src/core/comms/imessage-teammate-tasks.js';
import { imessageStateDir } from '../src/core/integrations/imessage.js';
import { parseFleetImessageTasksArgs, readFleetImessageTasks } from '../src/mcp/fleet-imessage-tasks.js';
import { createFleetTeammateTasksApi, projectTeammateTasks } from '../src/core/verse/fleet-teammate-tasks-api.js';

let runsDir: string;
const token = (n: number) => n.toString(16).padStart(32, '0');
/** A schema-valid stored task row; overrides carry state/receipt/result. */
function task(jobId: string, n: number, peer: string, kind: string, state: string, extra: Record<string, unknown> = {}) {
  return {
    jobId, peer, kind, scope: `FAKE_PRIVATE_SCOPE_${jobId}`, repo: 'fixture/example', prRefs: [],
    format: 'FAKE_PRIVATE_FORMAT', deadline: '2099-01-01T00:00:00.000Z',
    token: token(n), createdAt: 1763000000000 + n, state,
    metrics: [], settled: ['replied', 'expired', 'cancelled'].includes(state), ...extra,
  };
}
const TASKS = [
  task('FAKE-SEL-A', 1, 'dot', 'research', 'queued'),
  task('FAKE-SEL-B', 2, 'instinct', 'research', 'queued'),
  task('FAKE-SEL-C', 3, 'dot', 'triage', 'pending', { attemptedAt: 1763000001003,
    receipt: { rowid: 30, sent: true, delivered: false, error: 0 } }),
  task('FAKE-SEL-D', 4, 'instinct', 'report', 'replied', { attemptedAt: 1763000001004,
    receipt: { rowid: 31, sent: true, delivered: true, error: 0 },
    result: { rowid: 32, status: 'DONE', summary: 'FAKE_PRIVATE_RESULT', at: 1763000002004 } }),
];
function writeLedger(): void {
  const dir = imessageStateDir(runsDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'teammate-tasks.json'),
    JSON.stringify({ v: 1, tasks: TASKS, attempts: { dot: [], instinct: [] } }), { mode: 0o600 });
}
beforeEach(() => { runsDir = mkdtempSync(join(tmpdir(), 'task-selectors-')); writeLedger(); });
afterEach(() => { rmSync(runsDir, { recursive: true, force: true }); });

it('ANDs the bounded selectors on the stored row fields', () => {
  const row = { jobId: 'J', peer: 'dot', state: 'queued', kind: 'research' };
  expect(teammateTaskLedgerMatch(row, { peer: 'dot', state: 'queued' })).toBe(true);
  expect(teammateTaskLedgerMatch(row, { peer: 'dot', kind: 'triage' })).toBe(false);
  expect(teammateTaskLedgerMatch(row, {})).toBe(true);
  // A row that does not carry kind never matches a kind selector.
  expect(teammateTaskLedgerMatch({ jobId: 'J', peer: 'dot', state: 'queued' }, { kind: 'research' })).toBe(false);
});

describe('phm fleet imessage-tasks list', () => {
  const noConfig = () => { throw new Error('no config read allowed'); };
  const call = async (args: string[]) => {
    const output = vi.fn();
    const code = await cmdFleetImessageTasks(['list', ...args, '--json'],
      { list: () => listTeammateTasks({ runsDir }), config: noConfig, output });
    return { code, body: JSON.parse(output.mock.calls[0]![0] as string) };
  };
  it('filters by peer, state and kind, alone and ANDed with job', async () => {
    const peer = await call(['--peer', 'instinct']);
    expect(peer.body).toMatchObject({ selection: { peer: 'instinct' }, matched: true });
    expect(peer.body.tasks.map((t: { jobId: string }) => t.jobId)).toEqual(['FAKE-SEL-B', 'FAKE-SEL-D']);
    const kind = await call(['--kind', 'triage']);
    expect(kind.body.tasks.map((t: { jobId: string }) => t.jobId)).toEqual(['FAKE-SEL-C']);
    const state = await call(['--state', 'queued']);
    expect(state.body.tasks.map((t: { jobId: string }) => t.jobId)).toEqual(['FAKE-SEL-A', 'FAKE-SEL-B']);
    const combo = await call(['--job', 'FAKE-SEL-D', '--peer', 'instinct', '--state', 'replied', '--kind', 'report']);
    expect(combo.body).toMatchObject({ selection: { jobId: 'FAKE-SEL-D', peer: 'instinct', state: 'replied', kind: 'report' },
      matched: true });
    expect(combo.body.tasks.map((t: { jobId: string }) => t.jobId)).toEqual(['FAKE-SEL-D']);
    // Every supplied dimension must match: job+peer that disagree is an honest miss.
    const miss = await call(['--job', 'FAKE-SEL-A', '--peer', 'instinct']);
    expect(miss.body).toMatchObject({ matched: false, tasks: [] });
    const absent = await call(['--state', 'expired']);
    expect(absent.body).toMatchObject({ matched: false, tasks: [] });
    // No selector keeps the unfiltered report shape.
    const all = await call([]);
    expect(all.body.tasks).toHaveLength(4);
    expect(all.body).not.toHaveProperty('selection');
    expect(all.body).not.toHaveProperty('matched');
  });
  it('rejects out-of-enum selectors before any ledger read', async () => {
    const list = vi.fn(() => listTeammateTasks({ runsDir }));
    const output = vi.fn();
    for (const args of [['--peer', 'grok'], ['--state', 'running'], ['--kind', 'deploy'], ['--peer', 'DOT']]) {
      expect(await cmdFleetImessageTasks(['list', ...args, '--json'], { list, config: noConfig, output })).toBe(2);
    }
    expect(list).not.toHaveBeenCalled();
  });
  it('exposes the same selectors through the teammate-tasks alias', async () => {
    const output = vi.fn();
    expect(await cmdFleetTeammateTasks(['list', '--kind', 'report', '--json'],
      { list: () => listTeammateTasks({ runsDir }), output })).toBe(0);
    expect(JSON.parse(output.mock.calls[0]![0] as string).tasks.map((t: { jobId: string }) => t.jobId))
      .toEqual(['FAKE-SEL-D']);
  });
});

describe('fleet_imessage_tasks over MCP args and reader', () => {
  it('parses the bounded selectors and rejects everything else', () => {
    expect(parseFleetImessageTasksArgs({})).toEqual({ limit: 20 });
    expect(parseFleetImessageTasksArgs({ peer: 'dot', state: 'queued', kind: 'rebase', limit: 5 }))
      .toEqual({ peer: 'dot', state: 'queued', kind: 'rebase', limit: 5 });
    for (const args of [
      { peer: 'grok' }, { peer: 5 }, { peer: null }, { state: 'running' }, { state: null },
      { kind: 'deploy' }, { kind: null }, { peer: 'dot', extra: 1 }, { job: 'RQ-1' },
    ]) expect(parseFleetImessageTasksArgs(args)).toBeNull();
  });
  it('filters before the limit and echoes only supplied selectors', async () => {
    const read = (input: Parameters<typeof readFleetImessageTasks>[0]) =>
      readFleetImessageTasks(input, { runsDir });
    const instinct = await read({ peer: 'instinct', limit: 20 });
    expect(instinct).toMatchObject({ jobId: null, peer: 'instinct', matched: true });
    expect(instinct).not.toHaveProperty('state');
    expect(instinct).not.toHaveProperty('kind');
    expect(instinct.tasks!.map(t => t.jobId)).toEqual(['FAKE-SEL-B', 'FAKE-SEL-D']);
    const combo = await read({ jobId: 'FAKE-SEL-D', peer: 'instinct', state: 'replied', kind: 'report', limit: 20 });
    expect(combo).toMatchObject({ jobId: 'FAKE-SEL-D', peer: 'instinct', state: 'replied', kind: 'report', matched: true });
    expect(combo.tasks!.map(t => t.jobId)).toEqual(['FAKE-SEL-D']);
    const miss = await read({ state: 'expired', limit: 20 });
    expect(miss).toMatchObject({ state: 'expired', matched: false, tasks: [] });
    const all = await read({ limit: 20 });
    expect(all).toMatchObject({ jobId: null, matched: null });
    expect(all.tasks).toHaveLength(4);
    expect(all).not.toHaveProperty('peer');
    expect(all).not.toHaveProperty('kind');
    // The selection applies before limit truncation: newest match survives.
    const capped = await read({ peer: 'dot', limit: 1 });
    expect(capped.tasks!.map(t => t.jobId)).toEqual(['FAKE-SEL-C']);
  });
});

describe('teammate-tasks verse API', () => {
  const path = '/api/verse/fleet/control/teammate-tasks';
  type Raw = Parameters<typeof projectTeammateTasks>[0];
  // The view projection's sanitized result shape, as listTeammateTasks emits it.
  const raw = {
    schema: 'imessage.teammate-tasks.v1', state: 'healthy',
    tasks: TASKS.map(t => {
      const stored = (t as { result?: { rowid: number; status: string; at: number } }).result;
      return { ...t, resource: `imsg:${t.peer}`, claimKey: `queue:imsg.${t.peer}.${t.jobId}`,
        result: stored ? { rowid: stored.rowid, status: stored.status, at: stored.at, evidence: 'peer-reported' } : null };
    }),
  } as unknown as Raw;
  const call = async (query: string) => {
    send.mockClear();
    const filters: unknown[] = [];
    const api = createFleetTeammateTasksApi(() => raw, undefined,
      (_raw, filter) => { filters.push(filter); return new Map(); });
    expect(await api({} as VerseApiContext, { url: path + query } as IncomingMessage,
      {} as ServerResponse, path, 'GET')).toBe(true);
    return { status: send.mock.lastCall?.[1], body: send.mock.lastCall?.[2], filters };
  };
  it('accepts each bounded selector and ANDs them, echoing the selection', async () => {
    const peer = await call('?peer=instinct');
    expect(peer.status).toBe(200);
    expect(peer.body).toMatchObject({ selection: { peer: 'instinct' }, matched: true });
    // API rows sort by createdAt descending.
    expect(peer.body.rows.map((r: { jobId: string }) => r.jobId)).toEqual(['FAKE-SEL-D', 'FAKE-SEL-B']);
    expect(peer.filters).toEqual([{ peer: 'instinct' }]);
    const combo = await call('?job=FAKE-SEL-D&peer=instinct&state=replied&kind=report');
    expect(combo.body).toMatchObject({ selection: { jobId: 'FAKE-SEL-D', peer: 'instinct', state: 'replied', kind: 'report' },
      matched: true });
    expect(combo.body.rows.map((r: { jobId: string }) => r.jobId)).toEqual(['FAKE-SEL-D']);
    expect(combo.body.rows[0]).toMatchObject({ workState: 'REPORTED_DONE' });
    expect(combo.filters).toEqual([{ jobId: 'FAKE-SEL-D', peer: 'instinct', state: 'replied', kind: 'report' }]);
    const miss = await call('?state=expired');
    expect(miss.body).toMatchObject({ selection: { state: 'expired' }, matched: false, rows: [] });
    const all = await call('');
    expect(all.body).not.toHaveProperty('selection');
    expect(all.body.rows).toHaveLength(4);
    expect(all.filters).toEqual([{}]);
  });
  it('rejects unknown, duplicate and out-of-enum parameters before reading', async () => {
    const read = vi.fn(() => raw);
    const api = createFleetTeammateTasksApi(read, undefined, () => new Map());
    for (const query of ['?peer=grok', '?peer=', '?state=running', '?kind=deploy', '?peer=a&peer=b',
      '?job=FAKE-SEL-A&other=b', '?peer=dot&job=', '?limit=5']) {
      send.mockClear();
      expect(await api({} as VerseApiContext, { url: path + query } as IncomingMessage,
        {} as ServerResponse, path, 'GET')).toBe(true);
      expect(send.mock.lastCall?.[1]).toBe(400);
    }
    expect(read).not.toHaveBeenCalled();
  });
});
