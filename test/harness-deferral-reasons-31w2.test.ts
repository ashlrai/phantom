import { describe, expect, it, vi } from 'vitest';
import type { AshlrConfig, EngineId, WorkItem } from '../src/core/types.js';
import type { BackendAvailability, ResourceSnapshot } from '../src/core/fabric/resource-monitor.js';
import { buildGatewayDispatchPlan, planConcurrentDispatch } from '../src/core/fabric/concurrent-dispatch.js';

const timestamp = '2026-01-01T00:00:00.000Z';
function item(id = 'duplicate'): WorkItem {
  return { id, title: 'private title', goal: 'private goal', repo: '/synthetic', effort: 2,
    source: 'backlog', tags: [], createdAt: timestamp };
}
function repair(): WorkItem {
  return { ...item('repo:proposal-repair-capture:abcdef123456'), source: 'self',
    title: 'Repair dispatch capture failure for repo item repo:self-heal:123',
    detail: 'Dispatch capture repair: an autonomous dispatch produced repairable work but no proposal.\n' +
      'Original work item: repo:self-heal:123\nDispatch outcome: gate-blocked\n' +
      'Diff metadata: files=1, lines=3\nFailure: tests still failing\n' +
      'Produce a fresh complete fix, rerun merge-grade verification.',
    tags: ['self-heal', 'proposal-repair', 'dispatch-capture-repair', 'capture-gate'], ts: timestamp };
}
function reslice(): WorkItem {
  return { ...item('repo:proposal-repair-nodiff:abcdef123456'), source: 'self',
    title: 'Reslice no-diff dispatch for repo item repo:self-heal:123',
    detail: 'Diagnostic reslice: a dispatch completed without file changes.\n' +
      'Original work item: repo:self-heal:123\nDispatch outcome: empty-diff\n' +
      'Action: reslice the work into a smaller concrete edit.',
    tags: ['self-heal', 'proposal-repair', 'diagnostic-reslice', 'dispatch-no-diff-reslice'],
    ts: timestamp, repairParentItemId: 'repo:self-heal:123', repairParentSource: 'self',
    repairParentBackend: 'local-coder', repairParentTier: 'mid' };
}
function snapshot(entries: Array<[EngineId, BackendAvailability]>): ResourceSnapshot {
  return { generatedAt: timestamp, backends: entries.map(([backend, availability]) => ({
    backend, availability, usedPct: null, cap: null, capUnit: null, capWindow: null,
    resetsAt: null, costPerMTokenOut: 0, p50LatencyMs: null, snapshotAt: timestamp,
    reason: 'synthetic', backoffUntilMs: null,
  })) };
}
const cfg = { maxSlotsPerBackend: 1 };

describe('concurrent dispatch deferral reasons', () => {
  it('reports capacity for zero slots without invoking candidate or tier predicates', () => {
    const items = [item(), item()];
    const allow = vi.fn(() => false);
    const tier = vi.fn(() => 'mid' as const);
    const plan = planConcurrentDispatch(items, snapshot([['codex', 'exhausted'], ['builtin', 'exhausted']]),
      cfg, () => 'codex', allow, tier);
    expect(plan.assignments).toEqual([]);
    expect(plan.unassigned[0]).toBe(items[0]);
    expect(plan.unassigned[1]).toBe(items[1]);
    expect(plan.deferralReasons).toEqual({ 0: 'capacity', 1: 'capacity' });
    expect(allow).not.toHaveBeenCalled();
    expect(tier).not.toHaveBeenCalled();
  });

  it('caches denied preferred candidates and preserves the fallback assignment order', () => {
    const items = [item('one'), item('two'), item('three')];
    const calls: string[] = [];
    const allow = vi.fn((work: WorkItem, backend: EngineId) => {
      calls.push(`${work.id}:${backend}`);
      return backend !== 'codex' && work.id !== 'three';
    });
    const plan = planConcurrentDispatch(items, snapshot([['codex', 'open'], ['claude', 'open'], ['builtin', 'exhausted']]),
      cfg, () => 'codex', allow);
    expect(plan.assignments).toEqual([{ item: items[0], backend: 'claude' }]);
    expect(plan.unassigned).toEqual([items[1], items[2]]);
    expect(plan.deferralReasons).toEqual({ 1: 'capacity', 2: 'candidate-filter' });
    expect(calls).toEqual(['one:codex', 'one:claude', 'two:codex', 'two:claude', 'three:codex', 'three:claude']);
    expect(allow).toHaveBeenCalledTimes(6);
    expect(JSON.stringify(plan.deferralReasons)).not.toContain('private');
  });

  it('distinguishes duplicate positions, including editing-only work and builtin overflow', () => {
    const editing = repair();
    const first = item(editing.id);
    const overflow = { ...first };
    const plan = planConcurrentDispatch([first, editing, overflow], snapshot([]), cfg, () => 'builtin');
    expect(plan.assignments).toEqual([{ item: first, backend: 'builtin' }]);
    expect(plan.unassigned[0]).toBe(editing);
    expect(plan.unassigned[1]).toBe(overflow);
    expect(plan.deferralReasons).toEqual({ 1: 'candidate-filter', 2: 'capacity' });
  });

  it('prioritizes parent-tier, evaluating candidate and tier once per relevant pair', () => {
    const work = reslice();
    const allow = vi.fn((_work: WorkItem, _backend: EngineId) => true);
    const tier = vi.fn((backend: EngineId) => backend === 'claude' ? 'frontier' as const : 'mid' as const);
    const plan = planConcurrentDispatch([work], snapshot([['local-coder', 'exhausted'], ['claude', 'open'], ['claude', 'open'], ['builtin', 'open']]),
      cfg, () => 'local-coder', allow, tier);
    expect(plan.assignments).toEqual([]);
    expect(plan.unassigned[0]).toBe(work);
    expect(plan.deferralReasons).toEqual({ 0: 'parent-tier' });
    expect(allow.mock.calls.map(([, backend]) => backend)).toEqual(['claude']);
    expect(tier.mock.calls.map(([backend]) => backend)).toEqual(['claude']);
  });

  it('preserves same-tier substitution and does not reevaluate a denied preference', () => {
    const work = reslice();
    const allow = vi.fn((_work: WorkItem, backend: EngineId) => backend !== 'local-coder');
    const tier = vi.fn(() => 'mid' as const);
    const plan = planConcurrentDispatch([work], snapshot([['local-coder', 'open'], ['kimi', 'open'], ['builtin', 'open']]),
      cfg, () => 'local-coder', allow, tier);
    expect(plan.assignments).toEqual([{ item: work, backend: 'kimi' }]);
    expect(plan.unassigned).toEqual([]);
    expect(plan.deferralReasons).toEqual({});
    expect(allow.mock.calls.map(([, backend]) => backend)).toEqual(['local-coder', 'kimi']);
    expect(tier.mock.calls.map(([backend]) => backend)).toEqual(['kimi']);
  });

  it('returns coherent reasons in the never-throws builtin fallback', async () => {
    const first = item();
    const editing = repair();
    const diagnostic = reslice();
    const overflow = item();
    const plan = await buildGatewayDispatchPlan([first, editing, diagnostic, overflow],
      null as unknown as ResourceSnapshot, {} as AshlrConfig, cfg);
    expect(plan.assignments).toEqual([{ item: first, backend: 'builtin' }]);
    expect(plan.unassigned).toEqual([editing, diagnostic, overflow]);
    expect(plan.unassigned[0]).toBe(editing);
    expect(plan.deferralReasons).toEqual({ 1: 'candidate-filter', 2: 'parent-tier', 3: 'capacity' });
  });
});
