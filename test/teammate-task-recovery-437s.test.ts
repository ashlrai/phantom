/**
 * RQ-PHX-TEAMTASKRECOVER437S: recovered receipt-backed teammate tasks from
 * PR #5981 (head 88e98a9ca326f83d969d8711dec527ccaef9f12a), exercised through
 * the real `fleet teammate-tasks` entrypoint with an injected fake transport
 * and a temporary store. No iMessage send, token lookup or external API.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';
import { enqueueTeammateTask, listTeammateTasks, runTeammateTasks, teammateTaskPeers } from '../src/core/comms/imessage-teammate-tasks.js';
import { cmdFleetTeammateTasks, type FleetTeammateTasksDeps } from '../src/cli/fleet-teammate-tasks.js';
import { QueueStore } from '../src/core/queue/store.js';

const cfg = { comms: { enabled: true } } as AshlrConfig;
let runsDir: string;
let clock: number;
let nextRowid: number;
const approved = vi.fn((): string | null => 'fixture-handle');
const send = vi.fn(async (): Promise<'accepted' | 'uncertain' | 'refused'> => 'accepted');
const reconcile = vi.fn(async (): Promise<{ rowid: number; sent: boolean; delivered: boolean; error: number } | null> =>
  ({ rowid: nextRowid++, sent: true, delivered: true, error: 0 }));

const transport = () => ({ runsDir, now: () => clock, approved, send, reconcile });
const cliDeps = (out: string[]): FleetTeammateTasksDeps => ({
  config: () => cfg,
  now: () => clock,
  output: (text) => out.push(text),
  enqueue: (input, _cfg, opts = {}) => enqueueTeammateTask(input, cfg, { ...opts, ...transport() }),
  dispatch: (_cfg, opts = {}) => runTeammateTasks(cfg, { ...opts, ...transport() }),
  list: () => listTeammateTasks({ runsDir, now: () => clock }),
  peers: () => teammateTaskPeers({ runsDir, now: () => clock }),
});
const deadline = new Date(Date.now() + 3_600_000).toISOString();
const enqueueArgs = (jobId = 'RQ-FIXTURE-1', peer = 'dot') => ['enqueue', '--peer', peer, '--job', jobId, '--kind', 'research',
  '--scope', 'Investigate fixture failures', '--repo', 'example/fixture',
  '--format', 'Report findings with evidence', '--deadline', deadline, '--json'];
const tasks = () => listTeammateTasks({ runsDir, now: () => clock }).tasks;
const task = (jobId = 'RQ-FIXTURE-1') => tasks().find(row => row.jobId === jobId)!;
const queue = () => new QueueStore(join(runsDir, 'queue')).read();
/** Peer senderIds come from the module's own peer map; they are never printed. */
const peerSender = (): Record<string, string> =>
  Object.fromEntries(teammateTaskPeers({ runsDir, now: () => clock }).peers.map(peer => [peer.peer, peer.senderId]));
const seed = (text: string, senderId: string, rowid = nextRowid++, at = clock) => {
  mkdirSync(join(runsDir, 'imessage'), { recursive: true, mode: 0o700 });
  appendFileSync(join(runsDir, 'imessage', 'teammates.jsonl'),
    `${JSON.stringify({ v: 1, rowid, at: new Date(at).toISOString(), senderId, text })}\n`, { mode: 0o600 });
  return rowid;
};

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'teammate-tasks-'));
  clock = Date.parse('2026-11-15T12:00:00Z');
  nextRowid = 100;
  vi.stubEnv('HOME', runsDir);
  vi.stubEnv('ASHLR_RUNS_DIR', runsDir);
  vi.stubEnv('PHANTOM_STACKSYNC', 'off');
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(runsDir, { recursive: true, force: true }); });

describe('fleet teammate-tasks recovery', () => {
  it('previews enqueue, dispatch and list without sending or writing state', async () => {
    const out: string[] = [];
    const deps = cliDeps(out);
    expect(await cmdFleetTeammateTasks(enqueueArgs(), deps)).toBe(0);
    expect(await cmdFleetTeammateTasks(['dispatch', '--json'], deps)).toBe(0);
    expect(await cmdFleetTeammateTasks(['list', '--json'], deps)).toBe(0);
    expect(await cmdFleetTeammateTasks(['peers', '--json'], deps)).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    expect(readdirSync(runsDir)).toEqual([]);
    expect(JSON.parse(out[0]!)).toMatchObject({ state: 'planned', dryRun: true });
  });

  it('deduplicates enqueue across invocations and rejects a conflicting envelope', async () => {
    const deps = cliDeps([]);
    expect(await cmdFleetTeammateTasks([...enqueueArgs(), '--apply'], deps)).toBe(0);
    const token = task().token;
    expect(await cmdFleetTeammateTasks([...enqueueArgs(), '--apply'], deps)).toBe(0);
    expect(tasks()).toHaveLength(1);
    expect(task().token).toBe(token);
    const conflict = enqueueArgs().map(arg => arg === 'Investigate fixture failures' ? 'Different scope' : arg);
    expect(await cmdFleetTeammateTasks([...conflict, '--apply'], deps)).toBe(1);
    expect(tasks()).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
  });

  it('cannot mark a task sent without a reconciliation receipt and settles on a later pass', async () => {
    const deps = cliDeps([]);
    await cmdFleetTeammateTasks([...enqueueArgs(), '--apply'], deps);
    reconcile.mockResolvedValue(null);
    expect(await cmdFleetTeammateTasks(['dispatch', '--apply', '--json'], deps)).toBe(0);
    expect(task().state).toBe('sending');
    expect((await queue()).jobs[0]!.status).toBe('CLAIMED');
    expect(existsSync(join(runsDir, 'metrics', 'jobs.jsonl'))).toBe(false);
    clock += 121_000;
    reconcile.mockImplementation(async () => ({ rowid: nextRowid++, sent: true, delivered: true, error: 0 }));
    expect(await cmdFleetTeammateTasks(['dispatch', '--apply', '--json'], deps)).toBe(0);
    expect(task().state).toBe('pending');
    expect(send).toHaveBeenCalledOnce();
  });

  it('rejects results for the wrong peer, token or job and settles only the correlated reply', async () => {
    const deps = cliDeps([]);
    const senders = peerSender();
    await cmdFleetTeammateTasks([...enqueueArgs(), '--apply'], deps);
    await cmdFleetTeammateTasks(['dispatch', '--apply', '--json'], deps);
    expect(task().state).toBe('pending');
    const token = task().token;
    seed(`RESULT RQ-FIXTURE-1 ${token} DONE Wrong peer`, senders['instinct']!);
    seed(`RESULT RQ-FIXTURE-1 ${'0'.repeat(32)} DONE Wrong token`, senders['dot']!);
    seed(`RESULT RQ-OTHER ${token} DONE Wrong job`, senders['dot']!);
    seed(`RESULT RQ-FIXTURE-1 ${token} DONE Older than receipt`, senders['dot']!, 1);
    await cmdFleetTeammateTasks(['dispatch', '--apply', '--json'], deps);
    expect(task().state).toBe('pending');
    expect((await queue()).jobs[0]!.status).toBe('CLAIMED');
    const rowid = seed(`RESULT RQ-FIXTURE-1 ${token} DONE Fixture analysis complete`, senders['dot']!);
    await cmdFleetTeammateTasks(['dispatch', '--apply', '--json'], deps);
    expect(task()).toMatchObject({ state: 'replied', result: { status: 'DONE', rowid } });
    expect((await queue()).jobs[0]!.status).toBe('DONE');
    const listed = JSON.stringify(listTeammateTasks({ runsDir, now: () => clock }));
    expect(listed).not.toContain('Investigate fixture failures');
    expect(listed).not.toContain('Fixture analysis complete');
  });

  it('carries preview, apply and peer result across separate invocations on reopened state', async () => {
    const deps = cliDeps([]);
    const senders = peerSender();
    expect(await cmdFleetTeammateTasks(enqueueArgs(), deps)).toBe(0);
    expect(tasks()).toEqual([]);
    expect(await cmdFleetTeammateTasks([...enqueueArgs(), '--apply'], deps)).toBe(0);
    expect(task().state).toBe('queued');
    expect(await cmdFleetTeammateTasks(['dispatch', '--apply', '--json'], deps)).toBe(0);
    expect(task().state).toBe('pending');
    const rowid = seed(`RESULT RQ-FIXTURE-1 ${task().token} DONE Peer report`, senders['dot']!);
    expect(await cmdFleetTeammateTasks(['dispatch', '--apply', '--json'], deps)).toBe(0);
    expect(task()).toMatchObject({ state: 'replied', settled: true, result: { status: 'DONE', rowid } });
    expect(send).toHaveBeenCalledOnce();
  });

  it('rejects invalid arguments and serves list/peers without config', async () => {
    const out: string[] = [];
    const deps: FleetTeammateTasksDeps = {
      ...cliDeps(out),
      config: () => { throw new Error('config unavailable'); },
    };
    expect(await cmdFleetTeammateTasks(['bogus'], deps)).toBe(2);
    expect(await cmdFleetTeammateTasks(['--help'], deps)).toBe(0);
    expect(await cmdFleetTeammateTasks(['list', '--json'], deps)).toBe(0);
    expect(await cmdFleetTeammateTasks(['peers', '--json'], deps)).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(readdirSync(runsDir)).toEqual([]);
  });
});
