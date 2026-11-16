/**
 * RQ-PHX-TASKSETTLEMENTRECOVERY468S: a Dot/Instinct teammate task whose peer
 * result was checkpointed (`state=replied`) must survive a crash before queue
 * finish, jobs-metric append, answered marker and `settled` complete — without
 * dispatching the work twice and without losing unrelated queue/metric bytes.
 *
 * The boundary is forced with a scratch-path obstacle only: the queue
 * directory is made read-only after the result is seeded, so the real
 * `QueueStore.finish` write fails deterministically while reads still work.
 * No filesystem mocks, no production fault-injection hooks. Transport
 * (approved/send/reconcile) and the clock are the only fakes; enqueue, run,
 * QueueStore and the inbox/task/metrics stores are the real implementations.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';
import { enqueueTeammateTask, listTeammateTasks, runTeammateTasks, teammateTaskPeers } from '../src/core/comms/imessage-teammate-tasks.js';
import { cmdFleetTeammateTasks, type FleetTeammateTasksDeps } from '../src/cli/fleet-teammate-tasks.js';
import { QueueStore } from '../src/core/queue/store.js';

const cfg = { comms: { enabled: true } } as AshlrConfig;
const JOB = 'RQ-FIXTURE-468S';
const UNRELATED_JOB = 'RQ-UNRELATED-468S';
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
  output: (text) => out.push(text),
  enqueue: (input, _cfg, opts = {}) => enqueueTeammateTask(input, cfg, { ...opts, ...transport() }),
  dispatch: (_cfg, opts = {}) => runTeammateTasks(cfg, { ...opts, ...transport() }),
  list: () => listTeammateTasks({ runsDir, now: () => clock }),
  peers: () => teammateTaskPeers({ runsDir, now: () => clock }),
});
const enqueueArgs = () => ['enqueue', '--peer', 'dot', '--job', JOB, '--kind', 'research',
  '--scope', 'Investigate fixture settlement failures', '--repo', 'example/fixture',
  '--format', 'Report findings with evidence', '--deadline', new Date(clock + 3_600_000).toISOString(), '--json'];
const tasks = () => listTeammateTasks({ runsDir, now: () => clock }).tasks;
const task = () => tasks().find(row => row.jobId === JOB)!;
const queue = () => new QueueStore(join(runsDir, 'queue')).read();
const peerSender = (): Record<string, string> =>
  Object.fromEntries(teammateTaskPeers({ runsDir, now: () => clock }).peers.map(peer => [peer.peer, peer.senderId]));
const seed = (text: string, senderId: string, rowid = nextRowid++, at = clock) => {
  mkdirSync(join(runsDir, 'imessage'), { recursive: true, mode: 0o700 });
  appendFileSync(join(runsDir, 'imessage', 'teammates.jsonl'),
    `${JSON.stringify({ v: 1, rowid, at: new Date(at).toISOString(), senderId, text })}\n`, { mode: 0o600 });
  return rowid;
};
const queueDir = () => join(runsDir, 'queue');
const metricsPath = () => join(runsDir, 'metrics', 'jobs.jsonl');
const inboxPath = () => join(runsDir, 'imessage', 'teammates.jsonl');
const taskStorePath = () => join(runsDir, 'imessage', 'teammate-tasks.json');
const metricRows = () => readFileSync(metricsPath(), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const inboxRows = () => readFileSync(inboxPath(), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const answeredMarkers = (rowid: number) => inboxRows().filter(row => row.answered === rowid);

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'teammate-settle-'));
  clock = Date.now();
  nextRowid = 1000;
  vi.stubEnv('HOME', runsDir);
  vi.stubEnv('ASHLR_RUNS_DIR', runsDir);
  vi.stubEnv('PHANTOM_STACKSYNC', 'off');
});
afterEach(() => {
  vi.unstubAllEnvs();
  const dir = queueDir();
  if (existsSync(dir)) { try { chmodSync(dir, 0o700); } catch { /* best-effort cleanup */ } }
  rmSync(runsDir, { recursive: true, force: true });
});

describe('teammate task settlement restart', () => {
  it('recovers a replied checkpoint crashed before queue/metric settlement, exactly once', async () => {
    const deps = cliDeps([]);
    const senders = peerSender();
    // Reserve and dispatch once: the peer send and its receipt are real; only
    // transport approval/send/reconcile and the clock are injected.
    expect(await cmdFleetTeammateTasks([...enqueueArgs(), '--apply'], deps)).toBe(0);
    expect(await cmdFleetTeammateTasks(['dispatch', '--apply', '--json'], deps)).toBe(0);
    expect(task()).toMatchObject({ state: 'pending', settled: false });
    expect(send).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    const token = task().token;

    // Unrelated rows that must survive the crash and the recovery untouched.
    await new QueueStore(queueDir()).add({ id: UNRELATED_JOB, status: 'READY', priority: 'P2', tier: 'work',
      repo: 'example/fixture', scope: 'Unrelated fixture scope', acceptance: 'unrelated fixture acceptance',
      deps: [], claims: [] });
    mkdirSync(join(runsDir, 'metrics'), { recursive: true, mode: 0o700 });
    appendFileSync(metricsPath(), `${JSON.stringify({ event_id: 'fixture:unrelated:launch', event: 'launch',
      job: UNRELATED_JOB, lane: 'fixture', pool: 'fixture', tier: 'work', repo: 'example/fixture',
      ts: new Date(clock).toISOString(), state: 'SENT', evidence: 'fixture' })}\n`, { mode: 0o600 });

    // One correlated DONE result from the task's own peer.
    const resultRowid = seed(`RESULT ${JOB} ${token} DONE Fixture analysis complete`, senders['dot']!);
    const metricsBefore = readFileSync(metricsPath(), 'utf8');

    // Crash boundary: the replied checkpoint is durable, then the queue finish
    // write fails because the scratch queue directory is read-only.
    chmodSync(queueDir(), 0o555);
    let crashed: number;
    try {
      crashed = await cmdFleetTeammateTasks(['dispatch', '--apply', '--json'], deps);
    } finally {
      chmodSync(queueDir(), 0o700);
    }
    expect(crashed).toBe(1);

    // Pre-recovery state: checkpoint survived, settlement did not complete.
    expect(task()).toMatchObject({ state: 'replied', settled: false,
      result: { status: 'DONE', rowid: resultRowid, evidence: 'peer-reported' } });
    const held = (await queue()).jobs.find(job => job.id === JOB)!;
    expect(held.status).toBe('CLAIMED');
    expect(held.claims.at(-1)).toMatchObject({ owner: 'imsg:dot' });
    expect(held.claims.at(-1)?.finishedAt).toBeUndefined();
    expect(readFileSync(metricsPath(), 'utf8')).toBe(metricsBefore);
    expect(metricRows().filter(row => row.event_id === `imsg:${token}:finish`)).toHaveLength(0);
    expect(answeredMarkers(resultRowid)).toHaveLength(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);

    // Next invocation reopens all state from disk and finishes settlement once.
    const out: string[] = [];
    expect(await cmdFleetTeammateTasks(['dispatch', '--apply', '--json'], cliDeps(out))).toBe(0);
    expect(JSON.parse(out.join(''))).toMatchObject({ state: 'healthy', sent: 0, replied: 0, pending: 0 });
    expect(task()).toMatchObject({ state: 'replied', settled: true });
    const done = (await queue()).jobs.find(job => job.id === JOB)!;
    expect(done.status).toBe('DONE');
    expect(done.blockedReason).toBeUndefined();
    expect(done.claims.at(-1)).toMatchObject({ owner: 'imsg:dot' });
    expect(done.claims.at(-1)?.finishedAt).toBeTruthy();

    // Exactly one launch and one finish metric; every pre-crash byte preserved.
    const recoveredMetrics = readFileSync(metricsPath(), 'utf8');
    expect(recoveredMetrics.startsWith(metricsBefore)).toBe(true);
    const rows = metricRows();
    const launches = rows.filter(row => row.event_id === `imsg:${token}:launch`);
    const finishes = rows.filter(row => row.event_id === `imsg:${token}:finish`);
    expect(launches).toHaveLength(1);
    expect(finishes).toHaveLength(1);
    expect(launches[0]).toMatchObject({ event: 'launch', job: JOB, state: 'SENT', evidence: 'transport-receipt' });
    expect(finishes[0]).toMatchObject({ event: 'finish', job: JOB, state: 'REPLIED',
      evidence: 'peer-reported', exit_code: 0 });
    expect(rows.filter(row => row.event_id === 'fixture:unrelated:launch')).toHaveLength(1);

    // Exactly one answered marker for the correlated result row.
    expect(answeredMarkers(resultRowid)).toHaveLength(1);

    // No second dispatch: native send and reconcile were each called once.
    expect(send).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);

    // Unrelated queue row is preserved verbatim.
    expect((await queue()).jobs.find(job => job.id === UNRELATED_JOB)).toMatchObject({ status: 'READY' });

    // Operational list output carries peer-reported evidence only: no token,
    // scope, format or result body may leak through the CLI receipt.
    const listOut: string[] = [];
    expect(await cmdFleetTeammateTasks(['list', '--json'], cliDeps(listOut))).toBe(0);
    const raw = listOut.join('');
    for (const leaked of [token, 'Investigate fixture settlement failures',
      'Report findings with evidence', 'Fixture analysis complete', 'RESULT ', '"token"', '"settled"', '"metrics"'])
      expect(raw).not.toContain(leaked);
    const report = JSON.parse(raw);
    expect(report.tasks).toHaveLength(1);
    expect(report.tasks[0]).toMatchObject({ jobId: JOB, state: 'replied',
      result: { status: 'DONE', rowid: resultRowid, evidence: 'peer-reported' } });
    expect(report.coverage).toBe('local-evidence-only-peer-reported-results-unverified');

    // A further invocation is a strict no-op: no new send, metric, marker or write.
    const storeBytes = readFileSync(taskStorePath(), 'utf8');
    const settledMetrics = readFileSync(metricsPath(), 'utf8');
    const settledInbox = readFileSync(inboxPath(), 'utf8');
    const noopOut: string[] = [];
    expect(await cmdFleetTeammateTasks(['dispatch', '--apply', '--json'], cliDeps(noopOut))).toBe(0);
    expect(JSON.parse(noopOut.join(''))).toMatchObject({ state: 'healthy', sent: 0, replied: 0, pending: 0 });
    expect(readFileSync(taskStorePath(), 'utf8')).toBe(storeBytes);
    expect(readFileSync(metricsPath(), 'utf8')).toBe(settledMetrics);
    expect(readFileSync(inboxPath(), 'utf8')).toBe(settledInbox);
    expect(send).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(metricRows().filter(row => row.event_id === `imsg:${token}:finish`)).toHaveLength(1);
    expect(answeredMarkers(resultRowid)).toHaveLength(1);
  });
});
