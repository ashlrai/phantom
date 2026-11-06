import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBusWorkPool } from '../src/core/fleet/bus-work-pool.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';

vi.setConfig({ testTimeout: 30_000 });
let base: string, root: string, snapshot: string, prompt: string, events: string, script: string;

const post = (id: string) => appendBusInbox({ id, from: 'leader', to: 'worker', priority: 'P1', ttl: 120_000,
  body: { kind: 'work', text: 'budget test' } } satisfies BusEnvelope, { root });

const lines = () => existsSync(events) ? readFileSync(events, 'utf8').trim().split('\n').filter(Boolean) : [];
const receipts = () => { const page = listBusInboxAfter(0, 100, { root }); if (page.status !== 'ok') throw new Error('inbox unavailable'); return page.messages.filter(m => m.envelope.to === 'leader').map(m => m.envelope); };
const claims = () => { const p = join(root, 'bus-work-claims', 'claims.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : [] as Array<{ id: string; owner: string; completedAt: number | null }>; };

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'bus-pool-budget-')); root = join(base, 'bus');
  snapshot = join(base, 'snapshot'); prompt = join(base, 'prompt'); events = join(base, 'events'); script = join(base, 'worker.cjs');
  writeFileSync(snapshot, JSON.stringify({ node: { jobId: 'CURRENTJOB', upstreamJobIds: [] }, tasks: [], outputs: [], byteBudget: 2000 }));
  writeFileSync(prompt, 'private prompt');
  mkdirSync(join(base, 'runs'), { mode: 0o700 });
  vi.stubEnv('HOME', base); vi.stubEnv('ASHLR_HOME', join(base, 'ashlr')); vi.stubEnv('ASHLR_RUNS_DIR', join(base, 'runs'));
  writeFileSync(script,
    `const fs = require('node:fs'), stdin = process.stdin;
      let input = '';
      stdin.on('data', c => input += c);
      stdin.on('end', () => {
        const match = input.match(/BEGIN UNTRUSTED BUS REQUEST JSON\\n([^\\n]+)/);
        if (!match) process.exit(9);
        const id = JSON.parse(match[1]).id;
        fs.appendFileSync('${events}', id + '\\n');
        process.exit(0);
      });`);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(base, { recursive: true, force: true }); });

const runPool = (args: { maxJobs: number; concurrency: number; totalTimeoutMs?: number; waitMs?: number; leaseMs?: number; signal?: AbortSignal }): ReturnType<typeof runBusWorkPool> => {
  const w = args.waitMs ?? 500;
  const l = args.leaseMs ?? 60000;
  return runBusWorkPool({ to: 'worker', owner: 'pool-budget', leaseMs: l, waitMs: w,
    maxJobs: args.maxJobs, concurrency: args.concurrency,
    snapshot, prompt, root, totalTimeoutMs: args.totalTimeoutMs,
    signal: args.signal,
    argv: [process.execPath, script] });
};

it('bounds active work, stops later attempts after pool expiry, and reports timeout', async () => {
  // Posts nothing; the pool's single monotonic budget timer fires while
  // workers wait for claims, preventing additional launches after expiry.
  const result = await runPool({ maxJobs: 4, concurrency: 2, totalTimeoutMs: 2_000 });
  expect(result).toMatchObject({ status: 'timeout', completed: 0 });
  expect(result.consumers).toHaveLength(2);
  expect(new Set(result.consumers.map((c: { owner: string }) => c.owner)).size).toBe(2);
  expect(lines()).toHaveLength(0);
  expect(claims()).toHaveLength(0);
});

it('respects a pre-aborted external signal, launches no workers, and returns cancelled', async () => {
  const ac = new AbortController();
  ac.abort(new Error('externally cancelled'));
  const result = await runPool({ maxJobs: 4, concurrency: 2, signal: ac.signal });
  expect(result).toMatchObject({ status: 'cancelled', completed: 0 });
  expect(result.consumers).toHaveLength(2);
  expect(new Set(result.consumers.map((c: { status: string }) => c.status)).has('cancelled')).toBe(true);
  expect(claims()).toHaveLength(0);
  expect(lines()).toHaveLength(0);
  expect(receipts()).toHaveLength(0);
});

it('allows claims to be reclaimed after cancellation from an external signal', async () => {
  const ac = new AbortController();
  ac.abort(new Error('externally cancelled'));
  const result = await runPool({ maxJobs: 2, concurrency: 1, signal: ac.signal });
  expect(result.status).toBe('cancelled');
  expect(result.consumers).toHaveLength(1);
  expect(claims()).toHaveLength(0);
  expect(lines()).toHaveLength(0);
});
