/** runCosWorkOnce picks up `phm queue replay` retries (RQ-PHX-COSREPLAYPICKUP16).
 *
 * A replay gets a new id (`<id>.replay.<uuid>`, replayOf: <id>). The worker
 * claims and finishes the attempt by its own id but drafts against the root
 * `cos-<32 hex>` id. Every test roots at a fresh mkdtemp runsDir and fakes the
 * spawn seam, so no real CLI or login ever launches.
 */
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cosRootId, runCosWorkOnce } from '../src/core/cos/worker.js';
import { cosStatus, queueCosEnvelope } from '../src/core/cos/intake.js';
import type { SpawnedPlannerProcess, SpawnLike } from '../src/core/fleet/planner-run.js';
import { QueueStore } from '../src/core/queue/store.js';
import type { QueueJob } from '../src/core/queue/schema.js';

let runsDir: string;
beforeEach(async () => { runsDir = await mkdtemp(join(tmpdir(), 'cos-replay-')); });
afterEach(async () => { await rm(runsDir, { recursive: true, force: true }); });

const candidates = [{ provider: 'fake', argv: ['fake-cli'] }];
const store = () => new QueueStore(join(runsDir, 'queue'), 250);
const jobs = async () => (await store().read()).jobs;
const cosRoute = JSON.stringify({ kind: 'cos-intake', origin: { channel: 'cli', senderId: 'cos-local' } });

async function enqueueCos(body = 'Summarise the open PRs'): Promise<string> {
  return queueCosEnvelope({
    channel: 'cli', verifiedSenderId: 'cos-local', body,
    receivedAt: new Date().toISOString(), dedupeKey: 'b'.repeat(64),
  }, runsDir);
}

/** A SpawnLike that never execs; each call emits `output` and closes with `code`. */
function fakeRunner(output: string, code: number) {
  let calls = 0;
  const spawn: SpawnLike = () => {
    calls += 1;
    const events = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const proc = {
      stdin, stdout, stderr: new PassThrough(),
      kill: () => true,
      on: (event: string, listener: (...args: never[]) => void) => { events.on(event, listener); return proc; },
      once: (event: string, listener: (...args: never[]) => void) => { events.once(event, listener); return proc; },
    } as unknown as SpawnedPlannerProcess;
    stdin.resume();
    stdin.on('finish', () => {
      stdout.end(output);
      stdout.once('end', () => setImmediate(() => events.emit('close', code, null)));
    });
    return proc;
  };
  return { spawn, calls: () => calls };
}

const pass = (code: number, output = 'The answer.') =>
  runCosWorkOnce({ runsDir, spawn: fakeRunner(output, code).spawn, candidates, owner: 'test-worker' });

const job = (id: string, extra: Partial<QueueJob> = {}): QueueJob => ({
  id, status: 'READY', priority: 'P1', pool: 'work', tier: 'work', repo: 'ashlrai/phantom',
  scope: 'scope', acceptance: cosRoute, deps: [], claims: [], ...extra,
});

describe('cos worker replay pickup', () => {
  it('answers a replayed root and keeps the draft keyed to the root id', async () => {
    const root = await enqueueCos();
    expect(await pass(1)).toEqual({ outcome: 'blocked', id: root, reason: 'runner-exit-1' });
    expect((await jobs()).find(row => row.id === root)?.status).toBe('BLOCKED');

    const [replay] = await store().replay({ ids: [root] });
    expect(replay?.replayOf).toBe(root);

    const result = await pass(0, 'Three PRs are open.');
    expect(result).toEqual({ outcome: 'drafted', id: root, attemptId: replay!.id, provider: 'fake' });

    const status = await cosStatus(root, runsDir);
    expect(status.draft?.text).toBe('Three PRs are open.');
    expect(status.needsYou).toBe(true);
    const rows = await jobs();
    expect(rows.find(row => row.id === replay!.id)?.status).toBe('DONE');
    expect(rows.find(row => row.id === root)?.status).toBe('BLOCKED');
  });

  it('resolves the root through a retry of a retry', async () => {
    const root = await enqueueCos();
    await pass(2);
    const [first] = await store().replay({ ids: [root] });
    expect(await pass(3)).toEqual({ outcome: 'blocked', id: root, attemptId: first!.id, reason: 'runner-exit-3' });

    const [second] = await store().replay({ ids: [first!.id] });
    expect(second?.replayOf).toBe(first!.id);
    expect(await pass(0, 'Done at last.')).toEqual({ outcome: 'drafted', id: root, attemptId: second!.id, provider: 'fake' });
    expect((await cosStatus(root, runsDir)).draft?.text).toBe('Done at last.');
    expect((await jobs()).find(row => row.id === second!.id)?.status).toBe('DONE');
  });

  it('never picks a job whose replayOf leads to a non-cos id', async () => {
    await store().add(job('plain-root', { status: 'DONE' }));
    await store().add(job('plain-root.replay.x', { replayOf: 'plain-root', replayedAt: new Date().toISOString() }));
    const runner = fakeRunner('nope', 0);
    expect(await runCosWorkOnce({ runsDir, spawn: runner.spawn, candidates })).toEqual({ outcome: 'idle' });
    expect(runner.calls()).toBe(0);
    expect((await jobs()).find(row => row.id === 'plain-root.replay.x')?.status).toBe('READY');
  });

  it('never picks a replay whose acceptance is not a cos-intake route', async () => {
    const root = await enqueueCos();
    await pass(1);
    const rows = await jobs();
    const rootJob = rows.find(row => row.id === root)!;
    await store().add(job(`${root}.replay.forged`, {
      acceptance: '{"kind":"other"}', replayOf: root, replayedAt: new Date().toISOString(), scope: rootJob.scope,
    }));
    const runner = fakeRunner('nope', 0);
    expect(await runCosWorkOnce({ runsDir, spawn: runner.spawn, candidates })).toEqual({ outcome: 'idle' });
    expect(runner.calls()).toBe(0);
  });
});

describe('cosRootId', () => {
  const root = `cos-${'c'.repeat(32)}`;
  const stamp = new Date().toISOString();

  it('returns the own id, follows replayOf, and gives up on cycles, gaps and long chains', () => {
    const a = job(`${root}.replay.a`, { replayOf: root, replayedAt: stamp });
    const b = job(`${root}.replay.b`, { replayOf: a.id, replayedAt: stamp });
    const all = [job(root), a, b];
    expect(cosRootId(all[0]!, all)).toBe(root);
    expect(cosRootId(b, all)).toBe(root);
    // The root must exist in the queue, not merely be named.
    expect(cosRootId(b, [a, b])).toBeUndefined();

    const x = job('x', { replayOf: 'y', replayedAt: stamp });
    const y = job('y', { replayOf: 'x', replayedAt: stamp });
    expect(cosRootId(x, [x, y])).toBeUndefined();

    const chain: QueueJob[] = [job(root)];
    for (let i = 0; i < 9; i += 1) chain.push(job(`r${i}`, { replayOf: chain.at(-1)!.id, replayedAt: stamp }));
    expect(cosRootId(chain[8]!, chain)).toBe(root);
    expect(cosRootId(chain[9]!, chain)).toBeUndefined();
  });
});
