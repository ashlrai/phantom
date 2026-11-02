import { getEventListeners } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetBusWorkLoop } from '../src/cli/fleet-bus-work-loop.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { runBusWorkLoop, type BusWorkLoopOptions } from '../src/core/fleet/bus-work-loop.js';

vi.setConfig({ testTimeout: 30_000 });
let base: string, root: string, snapshot: string, prompt: string, marker: string;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 250; i++) { if (predicate()) return; await delay(20); }
  throw new Error('timed out waiting for child');
}
const post = (id: string) =>
  expect(appendBusInbox({ id, from: 'leader', to: 'worker', priority: 'P1', ttl: 120_000, body: { kind: 'work' } }, { root }).status).toBe('posted');
const launches = () => existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean) : [];
const claimFile = () => join(root, 'bus-work-claims', 'claims.json');
function replies() {
  const page = listBusInboxAfter(0, 100, { root });
  if (page.status !== 'ok') throw new Error('inbox unavailable');
  return page.messages.filter(row => row.envelope.to === 'leader');
}
// Harmless children that only record their pid: `quick` exits fast, `parked`
// sleeps far beyond any test budget, and `staged` exits fast on the first
// launch then parks, so sequential jobs exercise the shared deadline.
const quick = () => [process.execPath, '-e',
  `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(marker)},process.pid+'\\n');process.stdin.resume();setTimeout(()=>process.exit(0),50);`];
const parked = (ignoreTerm = false) => [process.execPath, '-e',
  `const fs=require('node:fs');${ignoreTerm ? "process.on('SIGTERM',()=>{});" : ''}` +
  `fs.appendFileSync(${JSON.stringify(marker)},process.pid+'\\n');process.stdin.resume();setTimeout(()=>process.exit(0),60000);`];
const staged = () => [process.execPath, '-e',
  `const fs=require('node:fs'),m=${JSON.stringify(marker)};` +
  `const n=fs.existsSync(m)?fs.readFileSync(m,'utf8').trim().split('\\n').filter(Boolean).length:0;` +
  `fs.appendFileSync(m,process.pid+'\\n');process.stdin.resume();setTimeout(()=>process.exit(0),n===0?50:60000);`];
function options(overrides: Partial<BusWorkLoopOptions> = {}): BusWorkLoopOptions {
  return { to: 'worker', owner: 'one', leaseMs: 30000, waitMs: 1000, maxJobs: 1, root, snapshot, prompt,
    argv: quick(), ...overrides };
}
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'bus-total-budget-')); root = join(base, 'bus');
  snapshot = join(base, 'snapshot'); prompt = join(base, 'prompt'); marker = join(base, 'launches');
  writeFileSync(snapshot, JSON.stringify({ node: { jobId: 'CURRENTJOB', upstreamJobIds: [] }, tasks: [], outputs: [], byteBudget: 2000 }));
  writeFileSync(prompt, 'fake prompt');
  mkdirSync(join(base, 'runs'), { mode: 0o700 });
  vi.stubEnv('TMPDIR', base); vi.stubEnv('HOME', base); vi.stubEnv('ASHLR_HOME', join(base, 'ashlr'));
  vi.stubEnv('ASHLR_RUNS_DIR', join(base, 'runs'));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(base, { recursive: true, force: true }); });

it('shares one monotonic deadline across sequential jobs', async () => {
  const counts = () => [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  const before = counts();
  post('first'); post('second');
  const started = Date.now();
  const result = await runBusWorkLoop(options({ maxJobs: 2, waitMs: 60000, timeoutMs: 60000,
    totalTimeoutMs: 3000, argv: staged() }));
  const elapsed = Date.now() - started;
  expect(result).toEqual({ status: 'timeout', completed: 1 });
  // The second child got only the remainder of one deadline, never a fresh
  // per-iteration budget: far under the 60s per-job controls, never early.
  expect(launches().length).toBeGreaterThanOrEqual(1);
  expect(elapsed).toBeGreaterThanOrEqual(2500);
  expect(elapsed).toBeLessThan(15000);
  expect(replies().map(r => (r.envelope.body as { inReplyTo: string }).inReplyTo)).toEqual(['first']);
  // The killed job's claim was released, not completed, and no later claim ran.
  expect(mutateBusWorkClaim({ action: 'acquire', id: 'second', owner: 'next', leaseMs: 1000, root }).status).toBe('acquired');
  expect(counts()).toEqual(before);
});

it('carries the same deadline into the claim wait after a completed job', async () => {
  post('first');
  const started = Date.now();
  const result = await runBusWorkLoop(options({ maxJobs: 2, waitMs: 60000, totalTimeoutMs: 3000 }));
  expect(result).toEqual({ status: 'timeout', completed: 1 });
  expect(Date.now() - started).toBeLessThan(15000);
  expect(launches()).toHaveLength(1);
  expect(replies()).toHaveLength(1);
});

it('times out an empty claim wait well before waitMs and clears the deadline timer', async () => {
  const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
  const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
  const started = Date.now();
  const result = await runBusWorkLoop(options({ waitMs: 60000, totalTimeoutMs: 537 }));
  expect(result).toEqual({ status: 'timeout', completed: 0 });
  expect(Date.now() - started).toBeLessThan(15000);
  expect(launches()).toHaveLength(0);
  expect(existsSync(claimFile())).toBe(false);
  const call = timeoutSpy.mock.calls.findIndex(args => args[1] === 537);
  expect(call).toBeGreaterThanOrEqual(0);
  expect(clearSpy).toHaveBeenCalledWith(timeoutSpy.mock.results[call]!.value);
});

it('stops and awaits the active child, suppresses the late reply and releases the owned claim', async () => {
  post('slow');
  const started = Date.now();
  const result = await runBusWorkLoop(options({ argv: parked(true), waitMs: 60000, timeoutMs: 60000,
    totalTimeoutMs: 3000 }));
  const elapsed = Date.now() - started;
  expect(result).toEqual({ status: 'timeout', completed: 0 });
  expect(launches()).toHaveLength(1);
  // The child ignores SIGTERM, so return had to await the ~1s SIGKILL
  // escalation; the pid is already reaped when the loop returns.
  expect(elapsed).toBeGreaterThanOrEqual(3500);
  expect(elapsed).toBeLessThan(25000);
  expect(() => process.kill(Number(launches()[0]), 0)).toThrow();
  expect(replies()).toHaveLength(0);
  expect(mutateBusWorkClaim({ action: 'acquire', id: 'slow', owner: 'next', leaseMs: 1000, root }).status).toBe('acquired');
});

it('keeps external cancellation distinct from the budget', async () => {
  const first = new AbortController();
  const before = getEventListeners(first.signal, 'abort').length;
  const waiting = runBusWorkLoop(options({ waitMs: 60000, totalTimeoutMs: 60000, signal: first.signal }));
  await delay(150); first.abort();
  expect(await waiting).toEqual({ status: 'cancelled', completed: 0 });
  expect(getEventListeners(first.signal, 'abort')).toHaveLength(before);
  expect(launches()).toHaveLength(0);
  // An external abort during an active child keeps the existing 'failed'
  // mapping even with a budget configured; only a lone expiry reports timeout.
  post('job');
  const second = new AbortController();
  const active = runBusWorkLoop(options({ argv: parked(), waitMs: 60000, totalTimeoutMs: 60000, signal: second.signal }));
  await until(() => launches().length === 1); second.abort();
  expect(await active).toEqual({ status: 'failed', completed: 0 });
  expect(replies()).toHaveLength(0);
});

it('rejects invalid total budgets before any effect', async () => {
  post('held');
  for (const totalTimeoutMs of [0, 1.5, 3600001, NaN, Infinity, -5])
    expect(await runBusWorkLoop(options({ totalTimeoutMs }))).toEqual({ status: 'invalid', completed: 0 });
  expect(launches()).toHaveLength(0);
  expect(existsSync(claimFile())).toBe(false);
  expect(mutateBusWorkClaim({ action: 'acquire', id: 'held', owner: 'next', leaseMs: 1000, root }).status).toBe('acquired');
});

it('rejects malformed --total-timeout-ms flags on the CLI with zero effects', async () => {
  post('held');
  const inbox = () => readFileSync(join(root, 'bus-inbox', 'messages.json'), 'utf8');
  const before = inbox();
  let output = '';
  const stream = new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } });
  const io = { stdout: stream, stderr: stream };
  const args = (extra: string[]) => ['--to', 'worker', '--owner', 'one', '--lease-ms', '5000', '--wait-ms', '500',
    '--max-jobs', '1', '--snapshot', snapshot, '--prompt', prompt, '--root', root, ...extra, '--', ...quick()];
  for (const value of ['0', '1.5', '3600001', 'abc', '-1', '1e3', '9007199254740992', '1\n', ''])
    expect(await cmdFleetBusWorkLoop(args(['--total-timeout-ms', value]), io)).toBe(2);
  expect(await cmdFleetBusWorkLoop(args(['--total-timeout-ms', '5', '--total-timeout-ms', '6']), io)).toBe(2);
  expect(await cmdFleetBusWorkLoop(args(['--total-timeout-ms']), io)).toBe(2);
  expect(launches()).toHaveLength(0);
  expect(existsSync(claimFile())).toBe(false);
  expect(inbox()).toBe(before);
  // A valid flag parses and bounds the real loop end to end.
  output = '';
  const started = Date.now();
  expect(await cmdFleetBusWorkLoop(args(['--total-timeout-ms', '600']), io)).toBe(0);
  expect(JSON.parse(output)).toEqual({ status: 'timeout', completed: 0 });
  expect(Date.now() - started).toBeLessThan(15000);
  expect(launches()).toHaveLength(0);
});

it('keeps per-iteration waitMs semantics when no total budget is set', async () => {
  post('job');
  expect(await runBusWorkLoop(options({ waitMs: 400 }))).toEqual({ status: 'max-jobs', completed: 1 });
  expect(await runBusWorkLoop(options({ waitMs: 200 }))).toEqual({ status: 'timeout', completed: 0 });
});
