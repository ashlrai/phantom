import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeNodeCapacity, parseNodeCapacityDoc, type NodeSnapshot } from '../src/core/drive/nodes/capacity-model.js';
import {
  fleetFootprints, fleetRunnable, mergeRate, planAutoscaleRoutes, type HarnessModelCost, type RouteNode,
} from '../src/core/drive/nodes/autoscale-router.js';

const GIB = 1024 ** 3, MIB = 1024 ** 2;
const T0 = Date.parse('2026-11-16T05:10:00.000Z');

/** Recorded-shape snapshots: the 128 GiB main MBP and the 8 GiB masons-macbook-pro (synthetic sample values, real RAM size). */
function mbp(over: Partial<NodeSnapshot> = {}): NodeSnapshot {
  return {
    node: 'main-mbp', measuredAtMs: T0, platform: 'darwin',
    cpu: { cores: 18, load: [20, 20, 20], busyPercent: 60 },
    mem: { totalBytes: 128 * GIB, freeBytes: null, freePercent: 43, pressureLevel: 1 },
    swap: { usedBytes: 7 * GIB, totalBytes: 8 * GIB, swapoutsTotal: 1 },
    processSource: 'ps',
    sessions: [
      { harness: 'codex', rootPid: 1, processes: 4, memBytes: 700 * MIB, cpuPercent: 40 },
      { harness: 'claude', rootPid: 2, processes: 6, memBytes: 900 * MIB, cpuPercent: 30 },
      { harness: 'grok', rootPid: 3, processes: 2, memBytes: 200 * MIB, cpuPercent: 5 },
    ],
    ...over,
  };
}
function mbp8(over: Partial<NodeSnapshot> = {}): NodeSnapshot {
  return {
    node: 'masons-macbook-pro', measuredAtMs: T0, platform: 'darwin',
    cpu: { cores: 8, load: [1, 1, 1], busyPercent: 10 },
    mem: { totalBytes: 8 * GIB, freeBytes: null, freePercent: 55, pressureLevel: 1 },
    swap: { usedBytes: 0, totalBytes: 0, swapoutsTotal: 0 },
    processSource: 'ps', sessions: [],
    ...over,
  };
}
const node = (s: NodeSnapshot, extra: Omit<RouteNode, 'doc'> = {}): RouteNode => ({ doc: computeNodeCapacity(s), ...extra });

const COSTS: HarnessModelCost[] = [
  { provider: 'codex', model: 'gpt-5.5', harness: 'codex', tokensPerJob: 2_000_000, minutesPerJob: 30 },
  { provider: 'claude', model: 'claude-opus-5-5', harness: 'claude', tokensPerJob: 1_000_000, minutesPerJob: 40 },
  { provider: 'grok', model: 'grok-5', harness: 'grok', tokensPerJob: 1_500_000, minutesPerJob: 20 },
];

describe('autoscale router scoring', () => {
  it('uses a Laplace-smoothed learned merge rate', () => {
    expect(mergeRate(undefined)).toBe(0.5);
    expect(mergeRate({ attempts: 8, merged: 6 })).toBe(0.7);
    expect(mergeRate({ attempts: 2, merged: 9 })).toBe(0.75);   // merged clamps to attempts
    expect(mergeRate({ attempts: -1, merged: 1 } as never)).toBe(0.5);
  });

  it('picks the best outcome per token and per minute, and honours the weight', () => {
    const outcomes = { codex: { attempts: 10, merged: 8 }, claude: { attempts: 10, merged: 8 }, grok: { attempts: 10, merged: 2 } };
    const input = { nodes: [node(mbp())], costs: COSTS, outcomes, nowMs: T0 + 1000 };
    // equal merge rate: claude halves tokens, codex is faster; grok merges rarely
    const [balanced] = planAutoscaleRoutes({ ...input, jobs: [{ id: 'j1' }] });
    expect(balanced).toMatchObject({ jobId: 'j1', nodeId: 'main-mbp', provider: 'claude', footprint: 'node' });
    const [tokens] = planAutoscaleRoutes({ ...input, jobs: [{ id: 'j', tokenWeight: 1 }] });
    expect(tokens!.provider).toBe('claude');
    const [minutes] = planAutoscaleRoutes({ ...input, jobs: [{ id: 'j', tokenWeight: 0 }] });
    expect(minutes!.provider).toBe('codex');
    expect(minutes!.mergesPerHour).toBeCloseTo(0.75 / 30 * 60, 4);
  });

  it('places cloud harnesses on the small node by their CLI footprint, learned from the fleet', () => {
    // main MBP is under kernel pressure: every placement must go to the 8 GiB node, which has never run codex.
    const plan = planAutoscaleRoutes({
      nodes: [node(mbp({ mem: { totalBytes: 128 * GIB, freeBytes: null, freePercent: 43, pressureLevel: 2 } })), node(mbp8(), { overheadMinutes: 1 })],
      costs: COSTS.filter(c => c.provider === 'codex'), outcomes: {}, nowMs: T0,
      jobs: Array.from({ length: 6 }, (_, i) => ({ id: `j${i}` })),
    });
    // 8 GiB at 55% free: (55-30)% = 2 GiB headroom; codex 700 MiB per session -> 2 sessions, then memory.
    expect(plan.filter(p => p.nodeId === 'masons-macbook-pro').map(p => p.footprint)).toEqual(['fleet', 'fleet']);
    expect(plan[2]).toMatchObject({ nodeId: null, rejected: { 'node-pressure': 1, memory: 1 } });
  });

  it('never routes to a stale node, an exhausted provider, a provider not on the node, or an unserved local model', () => {
    const costs: HarnessModelCost[] = [...COSTS, { provider: 'local', model: 'qwen3-32b', harness: 'codex', tokensPerJob: 1, minutesPerJob: 60, local: true }];
    const stale = planAutoscaleRoutes({ nodes: [node(mbp())], costs, outcomes: {}, nowMs: T0 + 10 * 60_000, jobs: [{ id: 'j' }] });
    expect(stale[0]).toMatchObject({ nodeId: null });
    expect(stale[0]!.rejected!['node-stale']).toBeGreaterThan(0);
    const limited = planAutoscaleRoutes({ nodes: [node(mbp(), { providers: ['codex', 'grok'] })], costs, outcomes: {},
      nowMs: T0, exhausted: ['codex'], jobs: [{ id: 'j', providers: ['codex', 'claude', 'local'] }] });
    expect(limited[0]).toMatchObject({ nodeId: null, rejected: { 'provider-exhausted': 1, 'provider-not-on-node': 2 } });
    const served = planAutoscaleRoutes({ nodes: [node(mbp(), { localModels: ['qwen3-32b'] })], costs, outcomes: {},
      nowMs: T0, jobs: [{ id: 'j', providers: ['local'] }] });
    expect(served[0]).toMatchObject({ provider: 'local', model: 'qwen3-32b', nodeId: 'main-mbp' });
  });

  it('loads an unserved local model only where its weights fit, once per node', () => {
    const local = (modelBytes?: number): HarnessModelCost[] => [{ provider: 'local', model: 'm', harness: 'codex', tokensPerJob: 1, minutesPerJob: 60, local: true,
      ...(modelBytes === undefined ? {} : { modelBytes }) }];
    const nodes = [node(mbp()), node(mbp8())];
    expect(planAutoscaleRoutes({ nodes, costs: local(), outcomes: {}, nowMs: T0, jobs: [{ id: 'j' }] })[0]!.rejected).toEqual({ 'model-not-served': 2 });
    // 20 GiB of weights fit only the 128 GiB host (16.6 GiB headroom there is too small too)
    expect(planAutoscaleRoutes({ nodes, costs: local(20 * GIB), outcomes: {}, nowMs: T0, jobs: [{ id: 'j' }] })[0]!.nodeId).toBeNull();
    const plan = planAutoscaleRoutes({ nodes, costs: local(10 * GIB), outcomes: {}, nowMs: T0, jobs: [{ id: 'a' }, { id: 'b' }] });
    // first placement loads 10 GiB on the MBP; the second reuses the loaded weights there
    expect(plan.map(p => p.nodeId)).toEqual(['main-mbp', 'main-mbp']);
  });

  it('routes over the recorded main-MBP capacity document (pgrep+footprint, 2026-11-16)', () => {
    const doc = parseNodeCapacityDoc(JSON.parse(readFileSync(join(__dirname, 'fixtures/node-autoscale/main-mbp-2026-11-16.json'), 'utf8')));
    expect(doc).not.toBeNull();
    expect(doc!.basis.process_source).toBe('pgrep+footprint');
    const now = Date.parse(doc!.measured_at);
    const plan = planAutoscaleRoutes({ nodes: [{ doc: doc! }], costs: COSTS, outcomes: {}, nowMs: now,
      jobs: Array.from({ length: 12 }, (_, i) => ({ id: `j${i}` })) });
    const placed = plan.filter(p => p.nodeId !== null).length;
    // Placements are bounded by measured CPU headroom, never above the document's own runnable counts summed.
    const runnable = Object.values(doc!.agents_runnable_now).reduce<number>((n, v) => n + (v ?? 0), 0);
    expect(placed).toBeGreaterThan(0);
    expect(placed).toBeLessThanOrEqual(runnable);
    expect(plan.find(p => p.nodeId === null)?.rejected?.cpu).toBeGreaterThan(0);
  });

  it('stops a node on swap growth but keeps routing to the others', () => {
    const prev = computeNodeCapacity(mbp());
    const growing: RouteNode = { doc: computeNodeCapacity(mbp({ measuredAtMs: T0 + 60_000, swap: { usedBytes: 7 * GIB, totalBytes: 8 * GIB, swapoutsTotal: 10_000 } }), prev) };
    const plan = planAutoscaleRoutes({ nodes: [growing, node(mbp8({ measuredAtMs: T0 + 60_000 }))], costs: COSTS, outcomes: {}, nowMs: T0 + 60_000, jobs: [{ id: 'j' }] });
    expect(plan[0]!.nodeId).toBe('masons-macbook-pro');
  });

  it('is deterministic regardless of input order', () => {
    const a = planAutoscaleRoutes({ nodes: [node(mbp()), node(mbp8())], costs: COSTS, outcomes: {}, nowMs: T0, jobs: [{ id: '1' }, { id: '2' }, { id: '3' }] });
    const b = planAutoscaleRoutes({ nodes: [node(mbp8()), node(mbp())], costs: [...COSTS].reverse(), outcomes: {}, nowMs: T0, jobs: [{ id: '1' }, { id: '2' }, { id: '3' }] });
    expect(a).toEqual(b);
  });

  it('names job-filter and empty-input rejections instead of an empty map', () => {
    const plan = planAutoscaleRoutes({ nodes: [node(mbp())], costs: COSTS, outcomes: {}, nowMs: T0,
      jobs: [{ id: 'p', providers: ['claude'] }, { id: 'm', models: ['no-such-model'] }, { id: 'ok' }] });
    // 'p' keeps only the claude cost row; 'm' excludes every model; 'ok' places.
    expect(plan[0]).toMatchObject({ jobId: 'p', nodeId: 'main-mbp', provider: 'claude' });
    expect(plan[1]).toMatchObject({ jobId: 'm', nodeId: null, rejected: { 'model-not-in-job': 3 } });
    expect(plan[2]).toMatchObject({ jobId: 'ok', nodeId: 'main-mbp' });
    const typo = planAutoscaleRoutes({ nodes: [node(mbp())], costs: COSTS, outcomes: {}, nowMs: T0,
      jobs: [{ id: 'j', providers: ['typo-provider'] }] })[0]!;
    expect(typo.nodeId).toBeNull();
    expect(typo.rejected).toEqual({ 'provider-not-in-job': 3 });
    // Degenerate inputs: no usable cost rows or no node documents at all.
    for (const input of [
      { nodes: [node(mbp())], costs: [], jobs: [{ id: 'j' }] },
      { nodes: [], costs: COSTS, jobs: [{ id: 'j' }] },
    ]) {
      const p = planAutoscaleRoutes({ ...input, outcomes: {}, nowMs: T0 })[0]!;
      expect(p.nodeId).toBeNull();
      expect(Object.keys(p.rejected!).length).toBeGreaterThan(0);
    }
    expect(planAutoscaleRoutes({ nodes: [], costs: COSTS, outcomes: {}, nowMs: T0, jobs: [{ id: 'j' }] })[0]!.rejected)
      .toEqual({ 'no-nodes': 1 });
    expect(planAutoscaleRoutes({ nodes: [node(mbp())], costs: [], outcomes: {}, nowMs: T0, jobs: [{ id: 'j' }] })[0]!.rejected)
      .toEqual({ 'no-costs': 1 });
  });

  it('sums fresh fleet runnable per harness and keeps unknown as null', () => {
    const docs = [computeNodeCapacity(mbp()), computeNodeCapacity(mbp8())];
    const fleet = fleetRunnable(docs, T0);
    expect(fleet.grok).toBe(docs[0]!.agents_runnable_now.grok);
    expect(fleet.devin).toBeNull();
    expect(fleetRunnable(docs, T0 + 10 * 60_000).codex).toBeNull();
    expect(fleetFootprints(docs).claude!.mem_bytes_max).toBe(900 * MIB);
  });
});
