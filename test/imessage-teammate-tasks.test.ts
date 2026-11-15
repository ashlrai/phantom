import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';
import { enqueueTeammateTask, listTeammateTasks, runTeammateTasks, teammateTaskPeers } from '../src/core/comms/imessage-teammate-tasks.js';
import { teammateNeedsReply, readTeammateTexts } from '../src/core/comms/imessage-teammate-inbox.js';
import { runTeammateResponder } from '../src/core/comms/imessage-teammate-worker.js';
import { QueueStore } from '../src/core/queue/store.js';
import { summarizeJobsLedger } from '../src/core/fleet/report-ledger.js';
import { useProcessHomeForTest } from '../src/core/real-home.js';

const PEERS = { dot: 'imessage:e2e0809f8676fb7d', instinct: 'imessage:f5228be7cfedb6cb' };
const cfg = { comms: { enabled: true } } as AshlrConfig;
let runsDir: string;
let clock: number;
let nextRowid: number;
const taskPath = () => join(runsDir, 'imessage', 'teammate-tasks.json');
const ledgerPath = () => join(runsDir, 'metrics', 'jobs.jsonl');
const queue = () => new QueueStore(join(runsDir, 'queue')).read();
const input = (jobId = 'RQ-FIXTURE-1', peer: 'dot' | 'instinct' = 'dot') => ({
  jobId, peer, kind: 'research' as const, scope: 'Investigate fixture failures', repo: 'example/fixture',
  prRefs: [17], format: 'Report findings with file references', deadline: new Date(clock + 3_600_000).toISOString(),
});
const options = () => ({
  runsDir, now: () => clock, apply: true,
  approved: vi.fn(() => 'fixture@example.test'),
  send: vi.fn(async (_text: string, _senderId: string) => 'accepted' as 'accepted' | 'refused' | 'uncertain'),
  reconcile: vi.fn(async () => ({ rowid: nextRowid++, sent: true, delivered: true, error: 0 })),
});
const tasks = () => listTeammateTasks({ runsDir, now: () => clock }).tasks;
const task = (jobId = 'RQ-FIXTURE-1') => tasks().find(row => row.jobId === jobId)!;
const seed = (text: string, senderId = PEERS.dot, rowid = nextRowid++, at = clock) => {
  mkdirSync(join(runsDir, 'imessage'), { recursive: true, mode: 0o700 });
  appendFileSync(join(runsDir, 'imessage', 'teammates.jsonl'), `${JSON.stringify({ v: 1, rowid, at: new Date(at).toISOString(), senderId, text })}\n`, { mode: 0o600 });
  return rowid;
};
const result = (jobId = 'RQ-FIXTURE-1', status = 'DONE', summary = 'Fixture analysis complete') =>
  `RESULT ${jobId} ${task(jobId).token} ${status} ${summary}`;

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'imessage-tasks-'));
  clock = Date.parse('2026-11-15T12:00:00Z');
  nextRowid = 100;
  vi.stubEnv('HOME', runsDir);
  useProcessHomeForTest();
  vi.stubEnv('ASHLR_RUNS_DIR', runsDir);
  vi.stubEnv('PHANTOM_STACKSYNC', 'off');
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(runsDir, { recursive: true, force: true }); });

describe('fleet-originated teammate task envelopes', () => {
  it('defaults to a side-effect-free preview and keeps listing read-only', async () => {
    const deps = options();
    await enqueueTeammateTask(input(), cfg, { ...deps, apply: false });
    await runTeammateTasks(cfg, { ...deps, apply: false });
    expect(tasks()).toEqual([]);
    expect(readdirSync(runsDir)).toEqual([]);
    expect(deps.send).not.toHaveBeenCalled();
    await enqueueTeammateTask(input(), cfg, { runsDir, now: () => clock });
    expect(readdirSync(runsDir)).toEqual([]);
  });

  it('reserves an imsg queue claim, sends one envelope, and ingests one correlated result', async () => {
    const deps = options();
    await enqueueTeammateTask(input(), cfg, deps);
    expect(deps.send).not.toHaveBeenCalled();
    expect(task()).toMatchObject({ jobId: 'RQ-FIXTURE-1', peer: 'dot', state: 'queued' });
    expect(task().token).toMatch(/^[a-f0-9]{32}$/);
    expect((await queue()).jobs[0]).toMatchObject({ id: 'RQ-FIXTURE-1', status: 'CLAIMED', claims: [{ owner: 'imsg:dot' }] });
    expect(statSync(taskPath()).mode & 0o777).toBe(0o600);
    expect(await runTeammateTasks(cfg, deps)).toMatchObject({ sent: 1 });
    expect(task().state).toBe('pending');
    const body = deps.send.mock.calls[0][0] as string;
    expect(body.split('\n')[0]).toBe(`TASK RQ-FIXTURE-1 ${task().token}`);
    for (const field of [input().scope, input().repo, input().format, input().deadline]) expect(body).toContain(field);
    expect(deps.send.mock.calls[0][1]).toBe(PEERS.dot);
    clock += 1000;
    const rowid = seed(result());
    expect(await runTeammateTasks(cfg, deps)).toMatchObject({ replied: 1 });
    expect(task()).toMatchObject({ state: 'replied', result: { status: 'DONE', rowid } });
    expect((await queue()).jobs[0].status).toBe('DONE');
    expect(readTeammateTexts({ runsDir }).texts).toHaveLength(0);
    expect(deps.send).toHaveBeenCalledOnce();
    await runTeammateTasks(cfg, deps);
    const growth = summarizeJobsLedger(readFileSync(ledgerPath(), 'utf8'), false, clock);
    expect(growth).toMatchObject({ launches: 1, finishes: 1, merges: 0, publishes: 0 });
    expect(growth.byLane).toContainEqual({ lane: 'imsg-dot', launches: 1, finishes: 1, merges: 0 });
    expect(JSON.stringify(listTeammateTasks({ runsDir }))).not.toContain(input().scope);
    expect(JSON.stringify(listTeammateTasks({ runsDir }))).not.toContain('Fixture analysis complete');
  });

  it.each(['BLOCKED', 'FAILED'])('records a %s reply as blocked queue work without claiming a merge', async status => {
    const deps = options();
    await enqueueTeammateTask(input(), cfg, deps);
    await runTeammateTasks(cfg, deps);
    seed(result(undefined, status, 'Fixture evidence unavailable'));
    await runTeammateTasks(cfg, deps);
    expect(task()).toMatchObject({ state: 'replied', result: { status } });
    expect((await queue()).jobs[0].status).toBe('BLOCKED');
    expect(summarizeJobsLedger(readFileSync(ledgerPath(), 'utf8'), false, clock)).toMatchObject({ finishes: 1, merges: 0 });
  });

  it('deduplicates enqueue and refuses an id with a different task or existing foreign claim', async () => {
    const deps = options();
    const first = input();
    await enqueueTeammateTask(first, cfg, deps);
    const token = task().token;
    await enqueueTeammateTask(first, cfg, deps);
    expect(tasks()).toHaveLength(1);
    expect(task().token).toBe(token);
    await expect(enqueueTeammateTask({ ...first, scope: 'Different work' }, cfg, deps)).rejects.toThrow();
    await expect(enqueueTeammateTask({ ...first, peer: 'instinct' }, cfg, deps)).rejects.toThrow();
    await new QueueStore(join(runsDir, 'queue')).add({ id: 'RQ-FOREIGN', status: 'CLAIMED', priority: 'P2', tier: 'work', repo: 'example/fixture', deps: [], scope: 'Existing work', acceptance: '', claims: [{ owner: 'another-agent', claimedAt: new Date(clock).toISOString() }] });
    await expect(enqueueTeammateTask(input('RQ-FOREIGN'), cfg, deps)).rejects.toThrow();
    expect((await queue()).jobs.find(job => job.id === 'RQ-FOREIGN')?.claims[0].owner).toBe('another-agent');
  });

  it.each([
    { jobId: '../invalid' }, { jobId: 'x'.repeat(81) }, { repo: 'https://github.com/example/fixture' }, { scope: '' },
    { deadline: 'not-a-date' }, { deadline: '2026-01-01T00:00:00Z' }, { prRefs: [0] },
    { scope: 'x'.repeat(5000) },
  ])('rejects invalid or oversized envelope fields before writing: %j', async patch => {
    await expect(enqueueTeammateTask({ ...input(), ...patch }, cfg, options())).rejects.toThrow();
    expect(existsSync(taskPath())).toBe(false);
  });

  it('rejects credential-shaped identifiers before persisting them', async () => {
    const fakeToken = ['sk', 'fixture'.repeat(8)].join('-');
    await expect(enqueueTeammateTask({ ...input(), jobId: fakeToken }, cfg, options())).rejects.toThrow();
    await expect(enqueueTeammateTask({ ...input(), repo: `example/${fakeToken}` }, cfg, options())).rejects.toThrow();
    expect(existsSync(taskPath())).toBe(false);
  });
});

describe('result correlation and echo safety', () => {
  it('keeps Dot and Instinct freeform questions reviewable without replies or local task dispatch', async () => {
    seed('Can you please research the fixture regressions?', PEERS.dot);
    seed('Can you please research the fixture triage report?', PEERS.instinct);
    const deps = options();
    const generate = vi.fn(async () => 'This must never be generated.');
    expect(await runTeammateResponder(cfg, { ...deps, generate })).toMatchObject({ pending: 2, sent: 0 });
    expect(generate).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
    expect(existsSync(join(runsDir, 'queue', 'ready.tsv'))).toBe(false);
    expect(existsSync(join(runsDir, 'queue', 'queue.v1.json'))).toBe(false);
    expect(readTeammateTexts({ runsDir }).texts.map(row => row.senderId)).toEqual([PEERS.dot, PEERS.instinct]);
  });

  it('ignores wrong peers, tokens, ids, old rowids and invalid result statuses', async () => {
    const deps = options();
    await enqueueTeammateTask(input(), cfg, deps);
    await runTeammateTasks(cfg, deps);
    seed(result(), PEERS.instinct);
    seed(`RESULT RQ-FIXTURE-1 ${'0'.repeat(32)} DONE Wrong token`);
    seed(`RESULT RQ-UNKNOWN ${task().token} DONE Wrong job`);
    seed(result(), PEERS.dot, 99);
    seed(result(undefined, 'MERGED'));
    seed(result(undefined, 'DONE', '   '));
    seed(`${result()}\nRESULT second line`);
    await runTeammateTasks(cfg, deps);
    expect(task().state).toBe('pending');
    expect(deps.send).toHaveBeenCalledOnce();
    expect((await queue()).jobs[0].status).toBe('CLAIMED');
    expect(summarizeJobsLedger(readFileSync(ledgerPath(), 'utf8'), false, clock).finishes).toBe(0);
    seed(result());
    await runTeammateTasks(cfg, deps);
    expect(task().state).toBe('replied');
  });

  it.each([
    'RESULT', 'RESULT malformed can you review fixture?',
    `RESULT RQ-UNKNOWN ${'0'.repeat(32)} DONE Can you please review the report?`,
    'TASK malformed please research fixture?',
  ])('never auto-replies to protocol messages: %s', text => {
    expect(teammateNeedsReply(text)).toBe(false);
  });

  it('never resends an uncertain attempt and reconciles it on a later pass', async () => {
    const deps = options();
    deps.send.mockResolvedValue('uncertain');
    deps.reconcile = vi.fn().mockResolvedValue(null);
    await enqueueTeammateTask(input(), cfg, deps);
    await runTeammateTasks(cfg, deps);
    expect(task().state).toBe('sending');
    clock += 121_000;
    await runTeammateTasks(cfg, deps);
    expect(deps.send).toHaveBeenCalledOnce();
    deps.reconcile.mockResolvedValue({ rowid: nextRowid++, sent: true, delivered: false, error: 0 });
    await runTeammateTasks(cfg, deps);
    expect(task().state).toBe('pending');
    expect(deps.send).toHaveBeenCalledOnce();
    expect(summarizeJobsLedger(readFileSync(ledgerPath(), 'utf8'), false, clock).launches).toBe(1);
  });

  it('honors revoked approval and transport refusal without losing or falsely launching work', async () => {
    const deps = options();
    await enqueueTeammateTask(input(), cfg, deps);
    const revoked = { ...deps, approved: vi.fn(() => null) };
    await runTeammateTasks(cfg, revoked);
    expect(deps.send).not.toHaveBeenCalled();
    expect(task().state).toBe('queued');
    deps.send.mockResolvedValue('refused');
    await runTeammateTasks(cfg, deps);
    expect(task().state).toBe('queued');
    const ledger = existsSync(ledgerPath()) ? readFileSync(ledgerPath(), 'utf8') : '';
    expect(summarizeJobsLedger(ledger, false, clock).launches).toBe(0);
  });

  it('uses the production transport live-policy refusal even after preflight approval', async () => {
    const deps = options();
    await enqueueTeammateTask(input(), cfg, deps);
    await runTeammateTasks(cfg, { ...deps, send: undefined, loadConfig: () => ({ comms: { enabled: false } }) as AshlrConfig });
    expect(task().state).toBe('queued');
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.reconcile).not.toHaveBeenCalled();
    expect(existsSync(ledgerPath())).toBe(false);
  });

  it('recovers queue and metric checkpoints without repeating a send or counting a result twice', async () => {
    const deps = options();
    await enqueueTeammateTask(input(), cfg, deps);
    // Simulate interruption after durable task reservation but before queue insertion.
    const queuePath = join(runsDir, 'queue', 'queue.v1.json');
    rmSync(queuePath);
    await runTeammateTasks(cfg, deps);
    const claimed = readFileSync(queuePath, 'utf8');
    seed(result());
    await runTeammateTasks(cfg, deps);
    const stored = JSON.parse(readFileSync(taskPath(), 'utf8'));
    stored.tasks[0].metrics = ['launch'];
    stored.tasks[0].settled = false;
    writeFileSync(taskPath(), JSON.stringify(stored));
    writeFileSync(queuePath, claimed);
    const launch = readFileSync(ledgerPath(), 'utf8').split('\n').filter(line => line && JSON.parse(line).event === 'launch').join('\n') + '\n';
    writeFileSync(ledgerPath(), launch);
    // Recover the durable result before its queue completion and metric append.
    await runTeammateTasks(cfg, deps);
    expect((await queue()).jobs[0].status).toBe('DONE');
    expect(summarizeJobsLedger(readFileSync(ledgerPath(), 'utf8'), false, clock)).toMatchObject({ launches: 1, finishes: 1 });
    // Recover an already-appended metric whose checkpoint was not saved.
    stored.tasks[0].metrics = [];
    writeFileSync(taskPath(), JSON.stringify(stored));
    await runTeammateTasks(cfg, deps);
    expect(summarizeJobsLedger(readFileSync(ledgerPath(), 'utf8'), false, clock)).toMatchObject({ launches: 1, finishes: 1 });
    expect(deps.send).toHaveBeenCalledOnce();
  });

  it('expires uncompleted work and rejects late results', async () => {
    const deps = options();
    await enqueueTeammateTask(input(), cfg, deps);
    await runTeammateTasks(cfg, deps);
    const line = result();
    clock += 3_600_001;
    seed(line);
    await runTeammateTasks(cfg, deps);
    expect(task().state).toBe('expired');
    expect((await queue()).jobs[0].status).toBe('BLOCKED');
    expect(deps.send).toHaveBeenCalledOnce();
  });

  it('does no send or mutation in a dry run against existing pending state', async () => {
    const deps = options();
    await enqueueTeammateTask(input(), cfg, deps);
    const before = readFileSync(taskPath(), 'utf8');
    await runTeammateTasks(cfg, { ...deps, apply: false });
    expect(readFileSync(taskPath(), 'utf8')).toBe(before);
    expect(deps.send).not.toHaveBeenCalled();
  });
});

describe('peer resource bounds', () => {
  it.each(['before enqueue', 'while queued', 'during preflight'])('honors KILL armed %s', async phase => {
    const deps = options();
    const arm = () => {
      mkdirSync(join(runsDir, '.ashlr'), { recursive: true, mode: 0o700 });
      writeFileSync(join(runsDir, '.ashlr', 'KILL'), 'kill switch active\n', { mode: 0o600 });
    };
    if (phase === 'before enqueue') {
      arm();
      await expect(enqueueTeammateTask(input(), cfg, deps)).rejects.toThrow();
      expect(existsSync(taskPath())).toBe(false);
    } else {
      await enqueueTeammateTask(input(), cfg, deps);
      if (phase === 'while queued') arm();
      else deps.approved.mockImplementation(() => { arm(); return 'fixture@example.test'; });
      await runTeammateTasks(cfg, deps);
      expect(task().state).toBe('queued');
    }
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.reconcile).not.toHaveBeenCalled();
  });

  it('expires a later peer task when an earlier send crosses its deadline', async () => {
    const deps = options();
    await enqueueTeammateTask(input('RQ-SLOW-DOT'), cfg, deps);
    await enqueueTeammateTask({ ...input('RQ-SHORT-INSTINCT', 'instinct'), deadline: new Date(clock + 1000).toISOString() }, cfg, deps);
    deps.send.mockImplementation(async () => { clock += 2000; return 'accepted'; });
    await runTeammateTasks(cfg, deps);
    expect(deps.send).toHaveBeenCalledOnce();
    expect(task('RQ-SLOW-DOT').state).toBe('pending');
    expect(task('RQ-SHORT-INSTINCT').state).toBe('expired');
    expect((await queue()).jobs.find(job => job.id === 'RQ-SHORT-INSTINCT')?.status).toBe('BLOCKED');
  });

  it('allows the twenty-fourth daily send and refuses the twenty-fifth', async () => {
    const deps = options();
    await enqueueTeammateTask(input('RQ-LIMIT-24'), cfg, deps);
    // A retained day of send receipts, spaced beyond the peer interval.
    const stored = JSON.parse(readFileSync(taskPath(), 'utf8'));
    stored.attempts.dot = Array.from({ length: 23 }, (_, index) => clock - (23 - index) * 120_001);
    writeFileSync(taskPath(), JSON.stringify(stored));
    await runTeammateTasks(cfg, deps);
    seed(result('RQ-LIMIT-24'));
    await runTeammateTasks(cfg, deps);
    expect(task('RQ-LIMIT-24').state).toBe('replied');
    clock += 120_001;
    await enqueueTeammateTask(input('RQ-LIMIT-25'), cfg, deps);
    await runTeammateTasks(cfg, deps);
    expect(deps.send).toHaveBeenCalledOnce();
    expect(task('RQ-LIMIT-25').state).toBe('queued');
  });

  it('serializes overlapping workers before a native side effect', async () => {
    const deps = options();
    await enqueueTeammateTask(input(), cfg, deps);
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    deps.send.mockImplementation(async () => { entered(); await pending; return 'accepted'; });
    const first = runTeammateTasks(cfg, deps);
    await enteredPromise;
    try { await expect(runTeammateTasks(cfg, deps)).rejects.toThrow('busy'); }
    finally { release(); await first; }
    expect(deps.send).toHaveBeenCalledOnce();
    expect(task().state).toBe('pending');
  });

  it('allows another peer while bounding each peer to one inflight task and a two-minute interval', async () => {
    const deps = options();
    await enqueueTeammateTask(input('RQ-DOT-1'), cfg, deps);
    await enqueueTeammateTask(input('RQ-DOT-2'), cfg, deps);
    await enqueueTeammateTask(input('RQ-INSTINCT-1', 'instinct'), cfg, deps);
    await runTeammateTasks(cfg, deps);
    expect(deps.send).toHaveBeenCalledTimes(2);
    expect(task('RQ-DOT-2').state).toBe('queued');
    seed(result('RQ-DOT-1'));
    await runTeammateTasks(cfg, deps);
    expect(task('RQ-DOT-1').state).toBe('replied');
    expect(task('RQ-DOT-2').state).toBe('queued');
    clock += 120_001;
    await runTeammateTasks(cfg, deps);
    expect(task('RQ-DOT-2').state).toBe('pending');
    expect(deps.send).toHaveBeenCalledTimes(3);
  });

  it('leaves corrupt state intact and never sends from it', async () => {
    const deps = options();
    await enqueueTeammateTask(input(), cfg, deps);
    writeFileSync(taskPath(), '{broken');
    await expect(runTeammateTasks(cfg, deps)).rejects.toThrow('invalid');
    expect(deps.send).not.toHaveBeenCalled();
    expect(readFileSync(taskPath(), 'utf8')).toBe('{broken');
    expect(() => listTeammateTasks({ runsDir })).toThrow('invalid');
  });

  it('reports capability evidence without asserting an unobserved GitHub or RQ execution', () => {
    const peers = JSON.stringify(teammateTaskPeers({ runsDir, now: () => clock }));
    expect(peers).toContain('dot');
    expect(peers).toContain('instinct');
    expect(peers).not.toContain('fixture@example.test');
    expect(readdirSync(runsDir)).toEqual([]);
  });
});
