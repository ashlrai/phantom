import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { queueWakePlan, runQueueWakePlan } from '../examples/agents/queue-wake-plan.js';
import type { FleetQueueV1 } from '../src/core/fleet/runs-parked-queue.js';
import type { FleetRunsDirState, FleetRunsLane } from '../src/core/fleet/runs-dir-state.js';

const at = '2026-01-01T00:00:00.000Z';
const lane = (name: string, held: boolean, running: number, target: number): FleetRunsLane => ({
  lane: name, held, running, target, heldReason: held ? 'operator hold' : null,
  floor: null, ceiling: null, queued: 0, tokensLastHour: null, merged24h: null, mergeRate24h: null,
});
const queue = (): FleetQueueV1 => ({
  v: 1, generatedAt: at, sources: { ready: 'healthy', skips: 'healthy' },
  total: 4, ready: 0, parked: 4, malformed: 0, byLane: [], skips: [], skipsLast24h: 0,
  groups: [
    { reason: 'DEPENDENCY', lane: 'held-lane', count: 1, jobs: ['fake-job-1'] },
    { reason: 'QUOTA', lane: 'full-lane', count: 1, jobs: ['fake-job-2'] },
    { reason: 'DEPENDENCY', lane: 'spare-lane', count: 1, jobs: ['fake-job-3'] },
    { reason: 'OTHER', lane: 'unmapped', count: 1, jobs: ['fake-job-4'] },
  ],
});
const runs = (): FleetRunsDirState => ({
  v: 1, generatedAt: at, runsDirPresent: true, sourceState: 'healthy',
  sources: { status: 'healthy', claimed: 'healthy', events: 'healthy', metrics: 'healthy', claudeLane: 'healthy', switches: 'healthy', drop: 'healthy' },
  lastTick: at, paused: false, memFreePct: 50, diskFreeGb: 20,
  lanes: [lane('held-lane', true, 0, 5), lane('full-lane', false, 2, 2), lane('spare-lane', false, 1, 3)],
  switches: [], claudeLane: null, publishesLastHour: [], events: [], claimed: [], drop: { pending: [], done: 0 },
});

describe('queue wake plan', () => {
  it('preserves reason and lane and classifies held before capacity, full, spare and unmapped', () => {
    const plan = queueWakePlan(queue(), runs(), at, 100);
    expect(plan.groups.map(g => [g.reason, g.lane, g.classification])).toEqual([
      ['DEPENDENCY', 'held-lane', 'held'], ['QUOTA', 'full-lane', 'no-capacity'],
      ['DEPENDENCY', 'spare-lane', 'capacity-available'], ['OTHER', 'unmapped', 'unknown'],
    ]);
    expect(plan.groups[0]?.status).toMatchObject({ held: true, running: 0, target: 5 });
    expect(plan.groups[3]?.status).toBeNull();
  });

  it('treats degraded status or queue as unknown, even for held or spare lanes', () => {
    const badRuns = runs(); badRuns.sources.status = 'degraded';
    expect(queueWakePlan(queue(), badRuns, at, 100).groups.every(g => g.classification === 'unknown')).toBe(true);
    const badQueue = queue(); badQueue.sources.ready = 'missing';
    expect(queueWakePlan(badQueue, runs(), at, 100).groups.every(g => g.classification === 'unknown')).toBe(true);
  });

  it('uses injected readers, clock and wait, limits output, and preserves source health', async () => {
    let output = '', errors = '', waited = 0;
    const unhealthy = runs(); unhealthy.sourceState = 'degraded'; unhealthy.sources.events = 'missing';
    const code = await runQueueWakePlan(['--runs-dir', '/fake/runs', '--limit', '2', '--wait-ms', '5'], {
      readQueue: async opts => { expect(opts.runsDir).toBe('/fake/runs'); expect(opts.now?.()).toBe(Date.parse(at)); return queue(); },
      readRuns: async opts => { expect(opts.runsDir).toBe('/fake/runs'); return unhealthy; },
      now: () => Date.parse(at), wait: async ms => { waited = ms; },
      stdout: text => { output += text; }, stderr: text => { errors += text; },
    });
    const plan = JSON.parse(output);
    expect(code).toBe(1); expect(errors).toBe(''); expect(waited).toBe(5);
    expect(plan).toMatchObject({ generatedAt: at, groupCount: 4, truncated: true, observation: { runs: { sources: { events: 'missing' } } } });
    expect(plan.groups).toHaveLength(2);
    expect(plan.groups[0].classification).toBe('held');
  });

  it('rejects invalid options and returns generic JSON errors without exposing reader errors', async () => {
    for (const args of [['--limit', '201'], ['--wait-ms', '30001'], ['--limit', '1', '--limit', '2'], ['--unknown', 'x']]) {
      let error = '';
      expect(await runQueueWakePlan(args, { stderr: text => { error += text; }, readQueue: async () => { throw new Error('must not read'); } })).toBe(2);
      expect(JSON.parse(error)).toEqual({ error: 'invalid_arguments' });
    }
    let error = '';
    expect(await runQueueWakePlan([], { readQueue: async () => { throw new Error('private source data'); }, readRuns: async () => runs(), stderr: text => { error += text; } })).toBe(1);
    expect(JSON.parse(error)).toEqual({ error: 'unavailable' });
  });

  it('cleans up signal handlers when the wait fails', async () => {
    const beforeInt = process.listenerCount('SIGINT'), beforeTerm = process.listenerCount('SIGTERM');
    let error = '';
    expect(await runQueueWakePlan(['--wait-ms', '1'], { wait: async () => { throw new Error('failed'); }, stderr: text => { error += text; } })).toBe(1);
    expect(JSON.parse(error)).toEqual({ error: 'unavailable' });
    expect(process.listenerCount('SIGINT')).toBe(beforeInt);
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
  });

  it('returns the signal exit code and removes handlers when interrupted during the wait', async () => {
    const beforeInt = process.listenerCount('SIGINT'), beforeTerm = process.listenerCount('SIGTERM');
    let error = '', reads = 0;
    const code = await runQueueWakePlan(['--wait-ms', '1'], {
      wait: async (_ms, signal) => {
        const handler = process.listeners('SIGINT').at(-1);
        expect(handler).toBeDefined();
        handler?.('SIGINT');
        expect(signal.aborted).toBe(true);
      },
      readQueue: async () => { reads++; return queue(); },
      stderr: text => { error += text; },
    });
    expect(code).toBe(130); expect(reads).toBe(0);
    expect(JSON.parse(error)).toEqual({ error: 'interrupted' });
    expect(process.listenerCount('SIGINT')).toBe(beforeInt);
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
  });

  it('reads real isolated projections without changing queue files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fake-wake-plan-'));
    try {
      const dir = join(root, 'queue'); await mkdir(dir);
      const ready = 'status\tid\tlane\nPARKED-DEPENDENCY.codex-local\tfake-job-1\tcodex-local\n';
      const status = JSON.stringify({ last_tick: at, paused: false, mem_free_pct: 50, lanes: { 'codex-local': { running: 0, target: 2, queued: 0, held: true } } });
      await writeFile(join(dir, 'ready.tsv'), ready);
      await writeFile(join(dir, 'status.json'), status);
      let output = '';
      expect(await runQueueWakePlan(['--runs-dir', root], { now: () => Date.parse(at), stdout: text => { output += text; } })).toBe(1);
      expect(JSON.parse(output).groups).toMatchObject([{ reason: 'DEPENDENCY', lane: 'codex-local', classification: 'held' }]);
      expect((await readdir(dir)).sort()).toEqual(['ready.tsv', 'status.json']);
      expect(await readFile(join(dir, 'ready.tsv'), 'utf8')).toBe(ready);
      expect(await readFile(join(dir, 'status.json'), 'utf8')).toBe(status);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
