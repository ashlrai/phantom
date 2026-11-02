import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BusWorkLoopOptions, BusWorkLoopResult } from '../src/core/fleet/bus-work-loop.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';

const seam = vi.hoisted(() => ({ run: vi.fn(), validate: vi.fn() }));
vi.mock('../src/core/fleet/bus-work-loop.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/core/fleet/bus-work-loop.js')>();
  return { ...actual,
    runBusWorkLoop: (opts: BusWorkLoopOptions) => seam.run(opts),
    validBusWorkLoopOptions: (opts: BusWorkLoopOptions) => seam.validate(opts),
  };
});
import { runBusWorkPool, type BusWorkPoolOptions } from '../src/core/fleet/bus-work-pool.js';

const actual = await vi.importActual<typeof import('../src/core/fleet/bus-work-loop.js')>('../src/core/fleet/bus-work-loop.js');
const options: BusWorkPoolOptions = { to: 'worker', owner: 'x'.repeat(128), leaseMs: 60_000, waitMs: 50,
  maxJobs: 5, concurrency: 2, snapshot: '/snapshot', prompt: '/prompt', argv: [process.execPath] };
const success: BusWorkLoopResult = { status: 'max-jobs', completed: 1 };
function deferred() {
  let resolve!: (result: BusWorkLoopResult) => void;
  const promise = new Promise<BusWorkLoopResult>(done => { resolve = done; });
  return { promise, resolve };
}
function setup() {
  seam.run.mockReset(); seam.validate.mockReset().mockImplementation(actual.validBusWorkLoopOptions);
}
afterEach(() => { vi.unstubAllEnvs(); });

it('rebalances unattempted capacity after a failure and waits for every running call', async () => {
  setup();
  const calls: Array<{ opts: BusWorkLoopOptions; gate: ReturnType<typeof deferred> }> = [];
  seam.run.mockImplementation((opts: BusWorkLoopOptions) => {
    const gate = deferred(); calls.push({ opts, gate }); return gate.promise;
  });
  let finished = false;
  const pending = runBusWorkPool(options).then(result => { finished = true; return result; });
  expect(calls).toHaveLength(2);
  expect(calls.every(c => c.opts.maxJobs === 1 && c.opts.owner.length <= 128)).toBe(true);
  expect(new Set(calls.map(c => c.opts.owner)).size).toBe(2);
  calls[0]!.gate.resolve({ status: 'failed', completed: 0 });
  await Promise.resolve();
  expect(calls).toHaveLength(2);
  expect(finished).toBe(false);
  for (let i = 1; i < 5; i++) {
    calls[i]!.gate.resolve(success);
    await Promise.resolve();
    if (i < 4) expect(calls).toHaveLength(i + 2);
  }
  const result = await pending;
  expect(calls).toHaveLength(5);
  expect(calls.slice(1).every(c => c.opts.owner === calls[1]!.opts.owner)).toBe(true);
  expect(result).toMatchObject({ status: 'failed', completed: 4,
    consumers: [{ status: 'failed', completed: 0, quota: 1 }, { status: 'max-jobs', completed: 4, quota: 4 }] });
});

it('reserves synchronously under simultaneous settlements and never exceeds concurrency or attempts', async () => {
  setup();
  const gates: ReturnType<typeof deferred>[] = [];
  let active = 0, peak = 0;
  seam.run.mockImplementation(() => {
    const gate = deferred(); gates.push(gate); active++; peak = Math.max(peak, active);
    return gate.promise.finally(() => { active--; });
  });
  const pending = runBusWorkPool({ ...options, maxJobs: 7, concurrency: 4 });
  expect(gates).toHaveLength(4);
  gates.slice(0, 4).forEach(g => g.resolve(success));
  await vi.waitFor(() => expect(gates).toHaveLength(7));
  gates.slice(4).forEach(g => g.resolve(success));
  const result = await pending;
  expect(peak).toBe(4);
  expect(gates).toHaveLength(7);
  expect(result.completed).toBe(7);
  expect(result.consumers.reduce((sum, c) => sum + c.quota, 0)).toBe(7);
});

it.each(['timeout', 'cancelled', 'invalid', 'thrown'] as const)('%s stops its consumer without retrying', async status => {
  setup();
  seam.run.mockImplementationOnce(() => status === 'thrown' ? Promise.reject(new Error('failed')) :
    Promise.resolve({ status, completed: 0 }));
  const result = await runBusWorkPool({ ...options, concurrency: 1 });
  expect(seam.run).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({ status: status === 'invalid' || status === 'thrown' ? 'failed' : status,
    completed: 0, consumers: [{ quota: 1 }] });
});

it('validates all derived options before launching anything', async () => {
  setup();
  seam.validate.mockImplementation((opts: BusWorkLoopOptions) =>
    actual.validBusWorkLoopOptions(opts) && !opts.owner.endsWith('-2'));
  expect(await runBusWorkPool(options)).toEqual({ status: 'invalid', completed: 0, consumers: [] });
  expect(seam.run).not.toHaveBeenCalled();
  expect(await runBusWorkPool({ ...options, argv: [] })).toEqual({ status: 'invalid', completed: 0, consumers: [] });
  expect(seam.run).not.toHaveBeenCalled();
});

it('uses the real claim and reply path once per request with bounded Node children', async () => {
  setup(); seam.run.mockImplementation(actual.runBusWorkLoop);
  const base = mkdtempSync(join(tmpdir(), 'bus-rebalance-'));
  try {
    const root = join(base, 'bus'), snapshot = join(base, 'snapshot'), prompt = join(base, 'prompt');
    const capture = join(base, 'capture'), script = join(base, 'child.cjs');
    mkdirSync(join(base, 'runs'), { mode: 0o700 });
    vi.stubEnv('HOME', base); vi.stubEnv('ASHLR_HOME', join(base, 'ashlr')); vi.stubEnv('ASHLR_RUNS_DIR', join(base, 'runs'));
    writeFileSync(snapshot, JSON.stringify({ node: { jobId: 'CURRENTJOB', upstreamJobIds: [] }, tasks: [], outputs: [], byteBudget: 2000 }));
    writeFileSync(prompt, 'test prompt');
    writeFileSync(script, `let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{
      const m=s.match(/BEGIN UNTRUSTED BUS REQUEST JSON[^\\n]*\\n([^\\n]+)/);
      if(!m)process.exit(2);require('node:fs').appendFileSync(process.argv[2],JSON.parse(m[1]).id+'\\n');
    });`);
    for (const id of ['one', 'two', 'three', 'four']) {
      expect(appendBusInbox({ id, from: 'leader', to: 'worker', priority: 'P1', ttl: 120_000,
        body: { kind: 'work' } }, { root }).status).toBe('posted');
    }
    const result = await runBusWorkPool({ ...options, maxJobs: 4, root, snapshot, prompt, argv: [process.execPath, script, capture] });
    expect(result).toMatchObject({ status: 'max-jobs', completed: 4 });
    expect(readFileSync(capture, 'utf8').trim().split('\n').sort()).toEqual(['four', 'one', 'three', 'two']);
    const page = listBusInboxAfter(0, 100, { root });
    expect(page.status).toBe('ok');
    if (page.status !== 'ok') throw new Error('inbox unavailable');
    const replies = page.messages.filter(m => m.envelope.to === 'leader');
    expect(replies.map(m => (m.envelope.body as { inReplyTo: string }).inReplyTo).sort()).toEqual(['four', 'one', 'three', 'two']);
    const claims = JSON.parse(readFileSync(join(root, 'bus-work-claims', 'claims.json'), 'utf8')) as Array<{ id: string; completedAt: number | null }>;
    expect(claims).toHaveLength(4);
    expect(claims.every(c => typeof c.completedAt === 'number')).toBe(true);
  } finally { rmSync(base, { recursive: true, force: true }); }
}, 30_000);
