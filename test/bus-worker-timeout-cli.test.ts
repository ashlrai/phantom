import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { cmdFleetBusWorkLoop } from '../src/cli/fleet-bus-work-loop.js';
import { cmdFleetBusClaimedRun } from '../src/cli/fleet-bus-claimed-run.js';
import { cmdFleetContextReply } from '../src/cli/fleet-context-reply.js';
import { runBusWorkLoop } from '../src/core/fleet/bus-work-loop.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });
let base: string, root: string, snapshot: string, prompt: string, requestFile: string, marker: string;
let childFinished: boolean;
const request = (id: string): BusEnvelope => ({ id, from: 'leader', to: 'worker', priority: 'P1', ttl: 120_000, body: { kind: 'work' } });
const sink = () => new Writable({ write(_chunk, _encoding, done) { done(); } });
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const claims = () => join(root, 'bus-work-claims', 'claims.json');
const launches = () => existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n') : [];
const child = (ignoreTerm = false, quick = false) => [process.execPath, '-e',
  `const fs=require('node:fs');${ignoreTerm ? "process.on('SIGTERM',()=>{});" : ''}` +
  `fs.appendFileSync(${JSON.stringify(marker)},process.pid+'\\n');process.stdin.resume();` +
  (quick ? 'process.stdin.on("end",()=>process.exit(0));' : 'setTimeout(()=>process.exit(0),20000);')];
const flags = (kind: string) => kind === 'loop'
  ? ['--to', 'worker', '--owner', 'owner', '--lease-ms', '6000', '--wait-ms', '500', '--max-jobs', '2', '--snapshot', snapshot, '--prompt', prompt, '--root', root]
  : ['--snapshot', snapshot, '--prompt', prompt, '--request-file', requestFile, '--reply-id', 'reply',
    ...(kind === 'claimed' ? ['--owner', 'owner', '--lease-ms', '6000', '--root', root] : [])];
async function run(kind: string, extra: string[], argv = child()) {
  let output = '';
  const stream = new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } });
  const io = { stdout: stream, stderr: stream };
  const args = [...flags(kind), ...extra, '--', ...argv];
  const code = kind === 'loop' ? await cmdFleetBusWorkLoop(args, io)
    : kind === 'claimed' ? await cmdFleetBusClaimedRun(args, io)
      : await cmdFleetContextReply(args, io, { root });
  childFinished = true;
  return { code, output };
}

beforeEach(() => {
  childFinished = false;
  base = mkdtempSync(join(tmpdir(), 'bus-timeout-')); root = join(base, 'bus');
  snapshot = join(base, 'snapshot'); prompt = join(base, 'prompt'); requestFile = join(base, 'request'); marker = join(base, 'launches');
  writeFileSync(snapshot, JSON.stringify({ node: { jobId: 'CURRENTJOB', upstreamJobIds: [] }, tasks: [], outputs: [], byteBudget: 2000 }));
  writeFileSync(prompt, 'test prompt'); writeFileSync(requestFile, JSON.stringify(request('first')));
  mkdirSync(join(base, 'runs'), { mode: 0o700 });
  vi.stubEnv('HOME', base); vi.stubEnv('ASHLR_HOME', join(base, 'ashlr')); vi.stubEnv('ASHLR_RUNS_DIR', join(base, 'runs'));
  expect(appendBusInbox(request('first'), { root }).status).toBe('posted');
  expect(appendBusInbox(request('second'), { root }).status).toBe('posted');
});
afterEach(() => {
  if (!childFinished) for (const pid of launches()) { try { process.kill(Number(pid), 'SIGKILL'); } catch { /* already exited */ } }
  vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(base, { recursive: true, force: true });
});

it.each(['loop', 'claimed', 'reply'])('%s terminates a slow child at the explicit deadline', async kind => {
  const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
  const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
  const start = Date.now();
  const result = await run(kind, ['--timeout-ms', '1800'], child(kind === 'claimed'));
  expect(Date.now() - start).toBeLessThan(15000);
  expect(result.code).not.toBe(0);
  expect(launches()).toHaveLength(1);
  if (kind === 'loop') expect(result.output).toContain('"status":"failed","completed":0');
  else expect(result.output).toContain('"exitCode":124');
  if (kind === 'claimed') {
    expect(result.output).toContain('"status":"released"');
    expect(result.output).toContain('SIGKILL');
  }
  if (kind !== 'reply') {
    expect(JSON.parse(readFileSync(claims(), 'utf8'))).toEqual([]);
    const renewalIndex = setIntervalSpy.mock.calls.findIndex(call => call[1] === 2000);
    expect(renewalIndex).toBeGreaterThanOrEqual(0);
    expect(clearIntervalSpy).toHaveBeenCalledWith(setIntervalSpy.mock.results[renewalIndex]!.value);
    const successor = mutateBusWorkClaim({ action: 'acquire', id: 'first', owner: 'successor', leaseMs: 30000, root });
    expect(successor.status).toBe('acquired');
    const state = readFileSync(claims(), 'utf8');
    await delay(2100);
    expect(readFileSync(claims(), 'utf8')).toBe(state);
    expect(launches()).toHaveLength(1);
  }
}, 20000);

it.each(['loop', 'claimed', 'reply'])('%s rejects malformed timeout flags before effects', async kind => {
  const inbox = readFileSync(join(root, 'bus-inbox', 'messages.json'), 'utf8');
  const bad = ['0', '1.5', '3600001', 'abc', '-1', '1e3', '1\n', '9007199254740992'];
  for (const value of bad) expect((await run(kind, ['--timeout-ms', value])).code).toBe(2);
  expect((await run(kind, ['--timeout-ms', '1', '--timeout-ms', '2'])).code).toBe(2);
  expect((await run(kind, ['--timeout-ms'])).code).toBe(2);
  expect(launches()).toHaveLength(0);
  expect(existsSync(claims())).toBe(false);
  expect(readFileSync(join(root, 'bus-inbox', 'messages.json'), 'utf8')).toBe(inbox);
});

it.each(['loop', 'claimed', 'reply'])('%s preserves omitted timeout and literal argv', async kind => {
  const result = await run(kind, [], child(false, true));
  expect(result.code, result.output).toBe(0);
  expect(launches()).toHaveLength(kind === 'loop' ? 2 : 1);
});

it('rejects an invalid core loop timeout before claiming', async () => {
  for (const timeoutMs of [0, 1.5, 3600001, NaN, Infinity]) {
    expect(await runBusWorkLoop({ to: 'worker', owner: 'owner', leaseMs: 900, waitMs: 500, maxJobs: 1,
      root, snapshot, prompt, argv: child(), timeoutMs })).toEqual({ status: 'invalid', completed: 0 });
  }
  expect(existsSync(claims())).toBe(false);
  expect(launches()).toHaveLength(0);
});

it.each(['loop', 'claimed', 'reply'])('%s advertises the timeout range in help', async kind => {
  let output = '';
  const out = new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } });
  const io = { stdout: out, stderr: sink() };
  const code = kind === 'loop' ? await cmdFleetBusWorkLoop(['--help'], io)
    : kind === 'claimed' ? await cmdFleetBusClaimedRun(['--help'], io) : await cmdFleetContextReply(['--help'], io);
  expect(code).toBe(0); expect(output).toContain('--timeout-ms <1..3600000>');
});
