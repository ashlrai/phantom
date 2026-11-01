import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { cmdFleetBusClaimedRun } from '../src/cli/fleet-bus-claimed-run.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

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
// The child drains stdin so the runner payload never EPIPEs, echoes it, records
// the launch in a counter file, then exits with the requested code after a delay.
const worker = (exit: number, wait = 0) => [process.execPath, '-e',
  `let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{` +
  `require('node:fs').appendFileSync(${JSON.stringify(spawned)},'spawn\\n');console.log(s);` +
  `setTimeout(()=>process.exit(${exit}),${wait})})`];
const claimsFile = () => join(busRoot, 'bus-work-claims', 'claims.json');
const spawnCount = () => { try { return readFileSync(spawned, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };

interface RunResult {
  code: number; cap: { out: string; err: string };
  claim: { status: string; detail?: string; leaseUntil?: number };
  workerExit: { status: string; exitCode?: number };
  replyReceipt: { status: string };
}
async function run(overrides: { replyId?: string; owner?: string; leaseMs?: number; argv?: string[] } = {}): Promise<RunResult> {
  const { cap, io } = capture();
  const code = await cmdFleetBusClaimedRun([
    '--snapshot', snapshot, '--prompt', prompt, '--request-file', requestFile,
    '--reply-id', overrides.replyId ?? 'reply-1', '--owner', overrides.owner ?? 'worker-a',
    '--lease-ms', String(overrides.leaseMs ?? 60_000), '--root', busRoot,
    '--', ...(overrides.argv ?? worker(0)),
  ], io);
  const line = cap.err.split('\n').map(l => l.trim()).find(l => l.startsWith('{"claim"'));
  return { code, cap, ...(line ? JSON.parse(line) : { claim: { status: 'unparsed' }, workerExit: { status: 'unparsed' }, replyReceipt: { status: 'unparsed' } }) } as RunResult;
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'bus-claimed-run-'));
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
afterEach(() => { vi.unstubAllEnvs(); rmSync(base, { recursive: true, force: true }); });

describe('fleet bus-claimed-run through the exported CLI, real inbox and claim store', () => {
  it('claims, runs the literal argv, publishes the reply and completes the lease', async () => {
    const result = await run({ argv: worker(0, 300) });
    expect(result).toMatchObject({ code: 0, claim: { status: 'completed' },
      workerExit: { status: 'returned', exitCode: 0 }, replyReceipt: { status: 'posted' } });
    expect(spawnCount()).toBe(1);
    // No claim token ever leaves the process boundary or the report. The
    // request body reaches the worker only as untrusted stdin data inside its
    // delimited section — never argv, and never the report stream.
    expect(result.cap.out + result.cap.err).not.toMatch(/[a-f0-9]{64}/);
    expect(result.cap.out).toContain('fake prompt');
    expect(result.cap.out).toContain('BEGIN UNTRUSTED BUS REQUEST JSON');
    expect(result.cap.out).toContain('fake request body never executed');
    expect(result.cap.err).not.toContain('fake request body never executed');
    const rows = JSON.parse(readFileSync(claimsFile(), 'utf8')) as { id: string; owner: string; completedAt: number | null }[];
    expect(rows).toEqual([expect.objectContaining({ id: 'req-1', owner: 'worker-a', completedAt: expect.any(Number) })]);
    const page = listBusInboxAfter(0, 50, { root: busRoot });
    const reply = page.status === 'ok' && page.messages.find(m => m.envelope.id === 'reply-1');
    expect(reply && reply.envelope.body).toMatchObject({ inReplyTo: 'req-1', kind: 'worker-exit', exitCode: 0, succeeded: true });
  });

  it('lets exactly one of two simultaneous invocations launch a child', async () => {
    const [first, second] = await Promise.all([
      run({ argv: worker(0, 300) }),
      run({ replyId: 'reply-2', argv: worker(0, 300) }),
    ]);
    expect([first.claim.status, second.claim.status].sort()).toEqual(['completed', 'conflict']);
    const loser = first.claim.status === 'conflict' ? first : second;
    expect(loser).toMatchObject({ code: 1, workerExit: { status: 'not-started' }, replyReceipt: { status: 'not-attempted' } });
    expect(spawnCount()).toBe(1);
  });

  it('keeps contenders out past the original lease while renewal holds it', async () => {
    // Lease and interval must exceed this host's claim-mutation latency for
    // renewals to land inside their window; only renewal keeps the contender out.
    const running = run({ leaseMs: 9000, argv: worker(0, 12000) });
    await delay(10500); // beyond the first 9000ms lease window: only renewals can fence a takeover
    const contender = await run({ replyId: 'reply-2', argv: worker(0) });
    expect(contender).toMatchObject({ code: 1, claim: { status: 'conflict' }, workerExit: { status: 'not-started' } });
    expect(await running).toMatchObject({ code: 0, claim: { status: 'completed' } });
    expect(spawnCount()).toBe(1);
  });

  it('refuses a previously completed receipt and launches nothing', async () => {
    expect((await run()).claim.status).toBe('completed');
    const again = await run({ replyId: 'reply-2' });
    expect(again).toMatchObject({ code: 1, claim: { status: 'completed' },
      workerExit: { status: 'not-started' }, replyReceipt: { status: 'not-attempted' } });
    expect(spawnCount()).toBe(1);
  });

  it('refuses missing and expired requests without launching', async () => {
    writeFileSync(requestFile, JSON.stringify(request('req-absent')));
    expect((await run()).claim.status).toBe('missing');
    post(request('req-short', 60));
    writeFileSync(requestFile, JSON.stringify(request('req-short', 60)));
    await delay(90);
    const expired = await run({ replyId: 'reply-3' });
    expect(expired).toMatchObject({ code: 1, claim: { status: 'expired' }, workerExit: { status: 'not-started' } });
    expect(spawnCount()).toBe(0);
  });

  it('releases a nonzero worker for a later retry and preserves its exit code', async () => {
    const first = await run({ argv: worker(7) });
    expect(first).toMatchObject({ code: 7, claim: { status: 'released' },
      workerExit: { status: 'returned', exitCode: 7 }, replyReceipt: { status: 'posted' } });
    expect(JSON.parse(readFileSync(claimsFile(), 'utf8'))).toEqual([]);
    const retry = await run({ replyId: 'reply-2' });
    expect(retry).toMatchObject({ code: 0, claim: { status: 'completed' } });
    expect(spawnCount()).toBe(2);
  });

  it('does not let a publication failure masquerade as completion', async () => {
    // A conflicting envelope already holding the reply id makes the post fail.
    expect(appendBusInbox({ id: 'reply-x', from: 'other', to: 'leader', priority: 'P3', ttl: 60_000, body: null },
      { root: busRoot }).status).toBe('posted');
    const result = await run({ replyId: 'reply-x' });
    expect(result).toMatchObject({ code: 1, claim: { status: 'released' },
      workerExit: { status: 'returned', exitCode: 0 }, replyReceipt: { status: 'conflict' } });
    expect(JSON.parse(readFileSync(claimsFile(), 'utf8'))).toEqual([]);
    expect((await run({ replyId: 'reply-y' })).claim.status).toBe('completed');
    expect(spawnCount()).toBe(2);
  });

  it('reports ownership loss distinctly without settling or undoing the child', async () => {
    const running = run({ leaseMs: 600, argv: worker(0, 700) });
    await delay(20);
    writeFileSync(claimsFile(), '{broken', { mode: 0o600 });
    const result = await running;
    // The argv could not be undone once launched; the corrupted store is left alone.
    expect(result.claim.status).toBe('ownership-lost');
    expect(['unavailable', 'expired']).toContain(result.claim.detail);
    expect(result).toMatchObject({ code: 1, workerExit: { status: 'returned', exitCode: 0 }, replyReceipt: { status: 'posted' } });
    expect(spawnCount()).toBe(1);
    expect(readFileSync(claimsFile(), 'utf8')).toBe('{broken');
  });

  it('rejects malformed input before any claim or child', async () => {
    writeFileSync(join(base, 'bad.json'), '{oops');
    const good = ['--snapshot', snapshot, '--prompt', prompt, '--request-file', requestFile,
      '--reply-id', 'reply-1', '--owner', 'worker-a', '--lease-ms', '60000', '--root', busRoot];
    const swap = (find: string, value: string) => good.map((x, i) => i === good.indexOf(find) + 1 ? value : x);
    const cases: string[][] = [
      good.slice(0, -1), // dangling --root with no value
      good.slice(0, -4), // missing --lease-ms and --root
      good.filter(x => x !== '--reply-id'), // orphaned value becomes an unknown flag
      swap('--lease-ms', '0'), swap('--lease-ms', '3600001'), swap('--lease-ms', 'abc'),
      swap('--snapshot', 'relative.json'),
      swap('--root', 'relative'),
      swap('--reply-id', 'req-1'), // reply id must differ from the request id
      swap('--request-file', join(base, 'bad.json')),
      swap('--request-file', join(base, 'absent.json')),
      swap('--owner', 'bad owner'),
      [...good, '--bogus', 'x'],
      [...good, '--owner', 'dupe'], // duplicate flag
    ];
    for (const flags of cases) {
      const { cap, io } = capture();
      expect(await cmdFleetBusClaimedRun([...flags, '--', ...worker(0)], io)).toBe(2);
      expect(cap.out + cap.err).not.toMatch(/[a-f0-9]{64}/);
    }
    const { io } = capture();
    expect(await cmdFleetBusClaimedRun([...good], io)).toBe(2); // no literal argv
    expect(await cmdFleetBusClaimedRun([...good, '--'], io)).toBe(2); // empty argv
    expect(spawnCount()).toBe(0);
    expect(() => readFileSync(claimsFile())).toThrow();
  });

  it('resolves through the fleet convention and owns its help', async () => {
    expect(resolveFleetSubcommand('bus-claimed-run')).toEqual({ module: './fleet-bus-claimed-run.js', exportName: 'cmdFleetBusClaimedRun' });
    const { cap, io } = capture();
    expect(await cmdFleetBusClaimedRun(['--help'], io)).toBe(0);
    expect(cap.out).toContain('bus-claimed-run');
  });
});
