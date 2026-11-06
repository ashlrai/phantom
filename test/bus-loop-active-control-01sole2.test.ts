import { spawn } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { runBusWorkLoop, type BusWorkLoopOptions } from '../src/core/fleet/bus-work-loop.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';

vi.setConfig({ testTimeout: 30_000 });
let base: string, root: string, cwd: string, snapshot: string, prompt: string, marker: string;
const delay = (ms: number) => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 250; i++) { if (predicate()) return; await delay(20); }
  throw new Error('timed out waiting for child');
}
function post(id: string, to = 'worker', body: unknown = { kind: 'work' }): void {
  expect(appendBusInbox({ id, from: 'leader', to, priority: 'P1', ttl: 120_000, body }, { root }).status).toBe('posted');
}
function replies() {
  const page = listBusInboxAfter(0, 100, { root });
  if (page.status !== 'ok') throw new Error('inbox unavailable');
  return page.messages.filter(row => row.envelope.to === 'leader');
}
function options(overrides: Partial<BusWorkLoopOptions> = {}): BusWorkLoopOptions {
  return { to: 'worker', owner: 'one', leaseMs: 3000, waitMs: 1000, maxJobs: 1, root, snapshot, prompt,
    argv: [process.execPath, '-e', `const fs=require('node:fs');let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(marker)}, input);setInterval(()=>{},1000)})`],
    ...overrides };
}
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'bus-active-control-')); root = join(base, 'bus'); cwd = join(base, 'cwd');
  snapshot = join(base, 'snapshot'); prompt = join(base, 'prompt'); marker = join(base, 'started');
  mkdirSync(cwd); mkdirSync(join(base, 'runs'));
  writeFileSync(snapshot, JSON.stringify({ node: { jobId: 'CURRENTJOB', upstreamJobIds: [] }, tasks: [], outputs: [], byteBudget: 2000 }));
  writeFileSync(prompt, 'fake prompt');
  vi.stubEnv('HOME', base); vi.stubEnv('ASHLR_HOME', join(base, 'ashlr')); vi.stubEnv('ASHLR_RUNS_DIR', join(base, 'runs'));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(base, { recursive: true, force: true }); });

it('forwards only caller controls, including cwd and bus routing, through the real reply path', async () => {
  const noticeRoot = join(base, 'ashlr', 'fleet');
  expect(appendBusInbox({ id: 'old', from: 'leader', to: 'notices', priority: 'P1', ttl: 120_000, body: 'old-notice' }, { root: noticeRoot }).status).toBe('posted');
  expect(appendBusInbox({ id: 'new', from: 'leader', to: 'notices', priority: 'P1', ttl: 120_000, body: 'new-notice' }, { root: noticeRoot }).status).toBe('posted');
  post('work', 'worker', { kind: 'work', cwd: base, timeoutMs: 1, busAddress: 'wrong', busAfter: 999 });
  const argv = [process.execPath, '-e', `const fs=require('node:fs');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{fs.writeFileSync('marker',s)})`];
  expect(await runBusWorkLoop(options({ cwd, argv, busAddress: 'notices', busAfter: 1 }))).toEqual({ status: 'max-jobs', completed: 1 });
  expect(existsSync(join(base, 'marker'))).toBe(false);
  const input = readFileSync(join(cwd, 'marker'), 'utf8');
  expect(input).toContain('new-notice'); expect(input).not.toContain('old-notice');
  expect(replies()).toHaveLength(1);
});

it('validates optional controls before acquisition and launches nothing for an already aborted signal', async () => {
  post('work');
  const bad = [{ cwd: join(base, 'missing') }, { cwd: 'relative' }, { timeoutMs: 0 }, { timeoutMs: 3600001 },
    { busAddress: 'bad address' }, { busAfter: -1 }, { signal: {} as AbortSignal }];
  for (const value of bad) expect(await runBusWorkLoop(options(value))).toEqual({ status: 'invalid', completed: 0 });
  const controller = new AbortController(); controller.abort();
  expect(await runBusWorkLoop(options({ signal: controller.signal }))).toEqual({ status: 'cancelled', completed: 0 });
  expect(existsSync(marker)).toBe(false); expect(replies()).toHaveLength(0);
  expect(mutateBusWorkClaim({ action: 'acquire', id: 'work', owner: 'check', leaseMs: 1000, root }).status).toBe('acquired');
});

it('honors the worker timeout and releases the failed attempt', async () => {
  post('work'); const started = Date.now();
  expect(await runBusWorkLoop(options({ timeoutMs: 300 }))).toEqual({ status: 'failed', completed: 0 });
  expect(existsSync(marker)).toBe(true); expect(Date.now() - started).toBeLessThan(3000);
  expect(replies()[0]?.envelope.body).toMatchObject({ exitCode: 124, succeeded: false });
  expect(mutateBusWorkClaim({ action: 'acquire', id: 'work', owner: 'check', leaseMs: 1000, root }).status).toBe('acquired');
});

it('aborts active children, launches no later work, and removes listeners across repeated calls', async () => {
  const counts = () => [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  const before = counts(); post('work'); post('next');
  for (let i = 0; i < 2; i++) {
    rmSync(marker, { force: true });
    const controller = new AbortController();
    const listeners = getEventListeners(controller.signal, 'abort').length;
    const running = runBusWorkLoop(options({ maxJobs: 2, signal: controller.signal }));
    await until(() => existsSync(marker)); controller.abort();
    expect(await running).toEqual({ status: 'failed', completed: 0 });
    expect(counts()).toEqual(before); expect(getEventListeners(controller.signal, 'abort')).toHaveLength(listeners);
    expect(replies()).toHaveLength(0);
  }
  expect(mutateBusWorkClaim({ action: 'acquire', id: 'next', owner: 'check', leaseMs: 1000, root }).status).toBe('acquired');
});

it('stops a child promptly after a successor takes ownership without settling the successor', async () => {
  post('work'); const running = runBusWorkLoop(options({ leaseMs: 900 }));
  await until(() => existsSync(marker));
  const file = join(root, 'bus-work-claims', 'claims.json');
  const rows = JSON.parse(readFileSync(file, 'utf8')) as { token: string }[];
  expect(mutateBusWorkClaim({ action: 'release', id: 'work', token: rows[0]!.token, root }).status).toBe('released');
  const successor = mutateBusWorkClaim({ action: 'acquire', id: 'work', owner: 'successor', leaseMs: 5000, root });
  expect(successor.status).toBe('acquired'); const started = Date.now();
  expect(await running).toEqual({ status: 'failed', completed: 0 });
  expect(Date.now() - started).toBeLessThan(2500); expect(replies()).toHaveLength(0);
  expect(mutateBusWorkClaim({ action: 'complete', id: 'work', token: successor.token, root }).status).toBe('completed');
});

it('stops a child when retryable renewal outlives the confirmed lease', async () => {
  post('work'); const running = runBusWorkLoop(options({ leaseMs: 900 }));
  await until(() => existsSync(marker));
  const lock = acquireLocalStoreLockWithOutcome(join(root, 'bus-work-claims', 'writer.lock'), 0,
    { anchorPath: root, exactPrivateStorage: true });
  expect(lock.state).toBe('acquired');
  try {
    expect(await running).toEqual({ status: 'failed', completed: 0 });
    expect(replies()).toHaveLength(0);
  } finally { releaseLocalStoreLock(lock.lock); }
});

it('handles SIGTERM while a child is active in an isolated process', async () => {
  post('work'); post('next');
  const moduleUrl = pathToFileURL(resolve('src/core/fleet/bus-work-loop.ts')).href;
  const script = `import {runBusWorkLoop} from ${JSON.stringify(moduleUrl)};const result=await runBusWorkLoop(${JSON.stringify(options({ maxJobs: 2 }))});console.log(JSON.stringify(result));`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk; });
  const closed = new Promise<number | null>(resolveClose => child.once('close', resolveClose));
  try {
    await until(() => existsSync(marker)); child.kill('SIGTERM');
    expect(await closed, errors).toBe(0);
    expect(JSON.parse(output)).toEqual({ status: 'failed', completed: 0 });
    expect(replies()).toHaveLength(0);
    expect(mutateBusWorkClaim({ action: 'acquire', id: 'next', owner: 'check', leaseMs: 1000, root }).status).toBe('acquired');
  } finally { if (child.exitCode === null) { child.kill('SIGKILL'); await closed; } }
});
