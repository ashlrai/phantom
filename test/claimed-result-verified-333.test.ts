/**
 * A real claimed bus job reaches VERIFIED on the work board only through a
 * passing opt-in local gate. Real stores in a private mkdtemp root (bus inbox,
 * bus work claims, work board); the only injected seams are the argv worker
 * (a fake node child) and the local gate's exec/metric deps.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { listWorkBoard } from '../src/core/comms/work-board.js';
import { runBusClaimedWork, type BusClaimedRunOptions } from '../src/core/fleet/bus-claimed-run.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import type { ContextReplyIO } from '../src/core/fleet/context-result-bus.js';
import type { LocalGateDeps } from '../src/core/fleet/local-gate.js';

vi.setConfig({ testTimeout: 60_000 });

const REQUEST_ID = 'fake-request-333';
const REPLY_ID = 'fake-reply-333';
const OWNER = 'fake-owner-333';

let base: string, busRoot: string, snapshot: string, prompt: string, requestFile: string;
const request = (): BusEnvelope =>
  ({ id: REQUEST_ID, from: 'fake-leader', to: 'fake-worker', priority: 'P1', ttl: 120_000, body: { kind: 'work', text: 'fake task' } });
const sink = () => new Writable({ write(_chunk, _encoding, done) { done(); } });
// Drains stdin so the prompt write never EPIPEs, then exits with `exit`.
const worker = (exit: number) => [process.execPath, '-e',
  `process.stdin.resume();process.stdin.on('end',()=>process.exit(${exit}))`];
const gate = (verdict: 'pass' | 'fail'): { deps: LocalGateDeps; calls: () => number } => {
  let calls = 0;
  return {
    deps: {
      exec: async (command, args) => {
        calls++;
        return { ok: !(verdict === 'fail' && args.includes('--noEmit')), stdout: command === 'git' ? 'a'.repeat(40) : '', stderr: '' };
      },
      appendMetric: async () => {},
    },
    calls: () => calls,
  };
};

/** Run the real claimed path. `check` and `io.gate` ride the options/io spread
 * into runContextReply exactly as runBusClaimedWork forwards them. */
const run = async (opts: { exit: number; verdict?: 'pass' | 'fail'; check?: boolean }) => {
  const g = gate(opts.verdict ?? 'pass');
  const options: BusClaimedRunOptions & { check?: Record<string, never> } = {
    snapshot, prompt, requestFile, replyId: REPLY_ID, owner: OWNER, leaseMs: 60_000, argv: worker(opts.exit),
    ...(opts.check ? { check: {} } : {}),
  };
  const io: ContextReplyIO = { stdout: sink(), stderr: sink(), gate: g.deps };
  const result = await runBusClaimedWork(options, io, { root: busRoot });
  return { result, gateCalls: g.calls() };
};
const replyBody = (): Record<string, unknown> => {
  const page = listBusInboxAfter(0, 50, { root: busRoot, now: () => 0 });
  if (page.status !== 'ok') throw new Error('bus inbox unavailable');
  const reply = page.messages.find(row => row.envelope.id === REPLY_ID);
  if (!reply) throw new Error('reply missing');
  return reply.envelope.body as Record<string, unknown>;
};
const item = () => {
  const board = listWorkBoard({ root: busRoot, now: Date.now() });
  expect(board.inbox).toBe('ok');
  const found = board.items.find(row => row.id === REQUEST_ID);
  if (!found) throw new Error('board item missing');
  return found;
};

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'claimed-result-verified-'));
  busRoot = join(base, 'bus');
  snapshot = join(base, 'snapshot.json'); prompt = join(base, 'prompt.txt'); requestFile = join(base, 'request.json');
  writeFileSync(snapshot, JSON.stringify({ node: { jobId: 'FAKEJOB', upstreamJobIds: [] }, tasks: [], outputs: [], byteBudget: 2000 }));
  writeFileSync(prompt, 'fake prompt');
  writeFileSync(requestFile, JSON.stringify(request()));
  vi.stubEnv('HOME', base); vi.stubEnv('ASHLR_HOME', join(base, '.ashlr')); vi.stubEnv('ASHLR_RUNS_DIR', join(base, 'runs'));
  mkdirSync(join(base, 'runs'), { mode: 0o700 });
  expect(appendBusInbox(request(), { root: busRoot }).status).toBe('posted');
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(base, { recursive: true, force: true }); });

it('a claimed job whose local gate passes shows VERIFIED with owner, claim receipt and reply source', async () => {
  const { result, gateCalls } = await run({ exit: 0, verdict: 'pass', check: true });
  expect(result).toMatchObject({ claim: { status: 'completed' }, workerExit: { status: 'returned', exitCode: 0 },
    replyReceipt: { status: 'posted' }, exitCode: 0 });
  expect(gateCalls).toBeGreaterThan(0);
  expect(replyBody()).toEqual({ inReplyTo: REQUEST_ID, kind: 'worker-exit', exitCode: 0, succeeded: true,
    verification: 'pass', verified: { tests: 'local-gate pass' } });
  const row = item();
  expect(row.state).toBe('VERIFIED');
  expect(row.source).toBe(`bus-reply:${REPLY_ID}`);
  expect(row.owner).toBe(OWNER);
  expect(row.claimReceipt).toMatch(new RegExp(`^bus-claim:${REQUEST_ID}:\\d+:\\d+$`));
});

it('a failing gate leaves the item unverified and stamps no verified key', async () => {
  const { result } = await run({ exit: 0, verdict: 'fail', check: true });
  expect(result.workerExit).toEqual({ status: 'returned', exitCode: 0 });
  const body = replyBody();
  expect(body).toMatchObject({ verification: 'fail', succeeded: false });
  expect(body).not.toHaveProperty('verified');
  expect(item().state).not.toBe('VERIFIED');
});

it('a zero exit without a check is not verification evidence', async () => {
  const { result, gateCalls } = await run({ exit: 0 });
  expect(result).toMatchObject({ claim: { status: 'completed' }, exitCode: 0 });
  expect(gateCalls).toBe(0);
  const body = replyBody();
  expect(body).toEqual({ inReplyTo: REQUEST_ID, kind: 'worker-exit', exitCode: 0, succeeded: true });
  expect(body).not.toHaveProperty('verified');
  expect(item().state).not.toBe('VERIFIED');
});

it('a passing gate cannot verify a nonzero worker exit', async () => {
  const { result, gateCalls } = await run({ exit: 3, verdict: 'pass', check: true });
  expect(result.workerExit).toEqual({ status: 'returned', exitCode: 3 });
  expect(gateCalls).toBe(0);
  const body = replyBody();
  expect(body).toMatchObject({ exitCode: 3, succeeded: false, verification: 'skipped' });
  expect(body).not.toHaveProperty('verified');
  expect(item().state).not.toBe('VERIFIED');
});
