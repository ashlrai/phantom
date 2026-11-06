import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { runBusClaimedWork, type BusClaimedRunOptions } from '../src/core/fleet/bus-claimed-run.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { runContextWorker } from '../src/core/fleet/context-worker-run.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock, type LocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import * as runsSwitches from '../src/core/fleet/runs-switches.js';

// Every claim-store mutation is a synchronous locked write that can cost
// seconds on a slow host, so lease horizons must clear that latency by a wide
// margin; renewal ticks (leaseMs/3 apart) must also leave the event loop time
// for context assembly and the spawn.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

let base: string, busRoot: string, snapshot: string, prompt: string, requestFile: string, spawned: string;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const request = (id = 'req-1', ttl = 120_000): BusEnvelope =>
  ({ id, from: 'leader', to: 'worker-a', priority: 'P1', ttl, body: { kind: 'work', text: 'fake request body never executed' } });
const post = (envelope: BusEnvelope) => { expect(appendBusInbox(envelope, { root: busRoot }).status).toBe('posted'); };
const sink = (write: (text: string) => void) => new Writable({ write(chunk, _e, done) { write(String(chunk)); done(); } });
const capture = () => {
  const cap = { out: '', err: '' };
  return { cap, io: { stdout: sink(s => { cap.out += s; }), stderr: sink(s => { cap.err += s; }) } };
};
// The child drains stdin so the runner payload never EPIPEs, records the launch
// in a marker file, then exits with the requested code after `wait` ms. Node's
// default SIGTERM handling kills it early — exactly what the abort drives.
const worker = (exit: number, wait = 0) => [process.execPath, '-e',
  `let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{` +
  `require('node:fs').appendFileSync(${JSON.stringify(spawned)},'spawn\\n');` +
  `setTimeout(()=>process.exit(${exit}),${wait})})`];
interface ClaimRow { id: string; cursor: number; receivedAt: number; ttl: number; token: string;
  owner: string; leaseMs: number; leaseUntil: number; completedAt: number | null }
const claimsFile = () => join(busRoot, 'bus-work-claims', 'claims.json');
const claimsRows = (): ClaimRow[] => JSON.parse(readFileSync(claimsFile(), 'utf8'));
const lockPath = () => join(busRoot, 'bus-work-claims', 'writer.lock');
const spawnCount = () => { try { return readFileSync(spawned, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
const waitSpawn = async () => { for (let i = 0; i < 600 && spawnCount() === 0; i++) await delay(25); };
const signalListeners = () => ['SIGINT', 'SIGTERM'].map(name => process.listenerCount(name));
// Unref'd intervals leave the process able to exit; counting Timeout handles by
// period is the observable check that the renewal loop was cleared.
const timeouts = (ms: number) =>
  (process as unknown as { _getActiveHandles(): { constructor?: { name?: string }; _idleTimeout?: number }[] })
    ._getActiveHandles().filter(h => h?.constructor?.name === 'Timeout' && h._idleTimeout === ms).length;
// Contending the claims writer lock makes every renewal answer 'retryable'.
const holdClaimsLock = (): LocalStoreLock => {
  const held = acquireLocalStoreLockWithOutcome(lockPath(), 0, { anchorPath: busRoot, exactPrivateStorage: true });
  if (held.state !== 'acquired') throw new Error(`precondition failed: claims writer lock ${held.state}`);
  return held.lock;
};
const claimed = (over: Partial<BusClaimedRunOptions> = {}) => {
  const { cap, io } = capture();
  const run = runBusClaimedWork({ snapshot, prompt, requestFile, replyId: 'reply-1', owner: 'worker-a',
    leaseMs: 60_000, argv: worker(0), ...over }, io, { root: busRoot });
  return { run, cap };
};

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'phx-claim-lease-abort-'));
  busRoot = join(base, 'bus');
  snapshot = join(base, 'snapshot.json'); prompt = join(base, 'prompt.txt');
  requestFile = join(base, 'request.json'); spawned = join(base, 'spawned.txt');
  writeFileSync(snapshot, JSON.stringify({ node: { jobId: 'CURRENTJOB', upstreamJobIds: [] }, tasks: [], outputs: [], byteBudget: 2000 }));
  writeFileSync(prompt, 'fake prompt');
  writeFileSync(requestFile, JSON.stringify(request()));
  vi.stubEnv('HOME', base); vi.stubEnv('ASHLR_HOME', join(base, '.ashlr')); vi.stubEnv('ASHLR_RUNS_DIR', join(base, 'runs'));
  mkdirSync(join(base, 'runs'), { mode: 0o700 });
  post(request());
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(base, { recursive: true, force: true }); });

describe('claimed bus work aborts the child when the lease is lost', () => {
  it('still claims, runs the child to exit zero, posts the reply and completes', async () => {
    const { run } = claimed({ argv: worker(0, 300) });
    const result = await run;
    expect(result).toMatchObject({ exitCode: 0, claim: { status: 'completed' },
      workerExit: { status: 'returned', exitCode: 0 }, replyReceipt: { status: 'posted' } });
    expect(spawnCount()).toBe(1);
    expect(claimsRows()).toEqual([expect.objectContaining({ owner: 'worker-a', completedAt: expect.any(Number) })]);
  });

  it('never spawns the worker for an already-aborted signal', async () => {
    const before = signalListeners();
    const controller = new AbortController();
    controller.abort();
    const { cap, io } = capture();
    const code = await runContextWorker({ snapshot, prompt, argv: worker(0, 45_000), signal: controller.signal }, io);
    expect(code).toBe(143);
    expect(spawnCount()).toBe(0);
    expect(cap.err).toContain('aborted');
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(signalListeners()).toEqual(before);
  });

  it('prevents launch when the signal aborts during context assembly', async () => {
    const before = signalListeners();
    const controller = new AbortController();
    const real = runsSwitches.readRunsSwitches;
    vi.spyOn(runsSwitches, 'readRunsSwitches').mockImplementation(async (...args) => {
      controller.abort();
      return real(...args);
    });
    const { cap, io } = capture();
    const code = await runContextWorker({ snapshot, prompt, argv: worker(0, 45_000), signal: controller.signal }, io);
    expect(code).toBe(143);
    expect(spawnCount()).toBe(0);
    expect(cap.err).toContain('aborted');
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(signalListeners()).toEqual(before);
  });

  it('kills a running child promptly on proven ownership loss and spares the successor claim', async () => {
    const before = signalListeners();
    const timersBefore = timeouts(3000);
    // A 9s lease renews every ~3s and rolls its horizon forward while owned, so
    // the lease stays alive through slow context assembly until surgery.
    const { run } = claimed({ leaseMs: 9000, argv: worker(0, 45_000) });
    await waitSpawn();
    expect(spawnCount()).toBe(1);
    // A successor takes the claim row over mid-run: the next renewal proves the
    // loss with 'mismatched-token', and the 45s child must die long before its sleep.
    const [row] = claimsRows();
    const successor = { ...row, owner: 'worker-b', token: 'b'.repeat(64) };
    writeFileSync(claimsFile(), JSON.stringify([successor]), { mode: 0o600 });
    const measured = Date.now();
    const result = await run;
    expect(Date.now() - measured).toBeLessThan(30_000);
    expect(result.claim).toMatchObject({ status: 'ownership-lost', detail: 'mismatched-token' });
    expect(result.workerExit).toMatchObject({ status: 'returned', exitCode: 143 });
    expect(result.exitCode).toBe(143);
    expect(result.replyReceipt.status).toBe('posted');
    // The losing run never completed or released the successor owner's row.
    expect(claimsRows()).toEqual([successor]);
    expect(signalListeners()).toEqual(before);
    expect(timeouts(3000)).toBe(timersBefore);
  });

  it('aborts once repeated lock refusals outlive the last confirmed lease horizon', async () => {
    const before = signalListeners();
    const timersBefore = timeouts(5000);
    const { run } = claimed({ leaseMs: 15_000, argv: worker(0, 45_000) });
    // Contend the writer lock from the start so every renewal is refused
    // 'retryable'; the ~15s horizon still leaves room for the child to spawn.
    const held = holdClaimsLock();
    await waitSpawn();
    expect(spawnCount()).toBe(1);
    const measured = Date.now();
    const result = await run;
    const elapsed = Date.now() - measured;
    expect(releaseLocalStoreLock(held)).toBe(true);
    expect(elapsed).toBeLessThan(40_000);
    expect(result.claim).toMatchObject({ status: 'ownership-lost', detail: 'expired' });
    expect(result.workerExit).toMatchObject({ status: 'returned', exitCode: 143 });
    // The stale row was never settled by the loser, so a successor can claim it
    // and the losing run's settlement must not disturb that claim.
    expect(claimsRows()).toEqual([expect.objectContaining({ owner: 'worker-a', completedAt: null })]);
    const next = mutateBusWorkClaim({ action: 'acquire', id: 'req-1', owner: 'worker-b', leaseMs: 60_000, root: busRoot });
    expect(next.status).toBe('acquired');
    expect(claimsRows()).toEqual([expect.objectContaining({ owner: 'worker-b', completedAt: null })]);
    expect(signalListeners()).toEqual(before);
    expect(timeouts(5000)).toBe(timersBefore);
  });

  it('does not abort on a transient lock refusal inside the confirmed horizon', async () => {
    const { run } = claimed({ leaseMs: 15_000, argv: worker(0, 8_000) });
    const held = holdClaimsLock();
    await delay(6_000); // covers one renewal tick (~5s), well inside the ~15s horizon
    expect(releaseLocalStoreLock(held)).toBe(true);
    const result = await run;
    expect(result).toMatchObject({ exitCode: 0, claim: { status: 'completed' },
      workerExit: { status: 'returned', exitCode: 0 }, replyReceipt: { status: 'posted' } });
    expect(spawnCount()).toBe(1);
  });

  it('honours a caller-supplied signal through the claimed path', async () => {
    const controller = new AbortController();
    controller.abort();
    const { run } = claimed({ signal: controller.signal });
    const result = await run;
    expect(result.claim.status).toBe('released');
    expect(result.exitCode).toBe(143);
    expect(result.workerExit).toMatchObject({ status: 'returned', exitCode: 143 });
    expect(spawnCount()).toBe(0);
    expect(claimsRows()).toEqual([]);
  });
});
