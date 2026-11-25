import { describe, expect, it } from 'vitest';
import { classifyOrder, orderEvidence, type TraceOrder } from '../src/core/fleet/order-work-state.js';
import type { OrderTraceJob } from '../src/core/fleet/order-trace.js';
import type { LaneTargetsV1 } from '../src/core/fleet/runs-lane-targets.js';

const at = '2026-11-13T12:00:00.000Z';
const url = 'https://github.com/example/project/pull/123';
const job = (id: string, state: OrderTraceJob['state'], lane = 'worker', artifact: string | null = null): OrderTraceJob =>
  ({ id, state, lane, url: artifact });
const merged = job('RQ-DONE', 'merged', 'done', url);
const queued = job('RQ-QUEUED', 'queued', 'held');
const launched = job('RQ-LIVE', 'launched', 'live');
const order = (jobs: OrderTraceJob[]): TraceOrder => ({ key: 'order', at: '2026-11-12 22:29', source: 'desktop', jobs });
const live = { at, jobIds: new Set(['RQ-LIVE']) };
const lanes: LaneTargetsV1 = { v: 1, generatedAt: at, sourceState: 'healthy', lanes: [{
  lane: 'held', target: 0, floor: 0, ceiling: 2, held: true, heldReason: null, heldUntil: null,
  pausedFrom: null, lastChange: null, changedBy: null,
}] };
const classify = (o: TraceOrder) => classifyOrder(o, at, at, live, lanes);

describe('partial order completion', () => {
  it('keeps queued work actionable and leaves the original order unchanged', () => {
    const o = order([merged, queued]);
    const before = structuredClone(o);
    expect(orderEvidence(o, at).verified).toBeUndefined();
    expect(classifyOrder(o, at, at).state).toBe('RECEIVED');
    expect(o).toEqual(before);
  });
  it('attributes live work to the launched sibling', () => {
    const o = order([merged, launched]);
    expect(orderEvidence(o, at, live)).toMatchObject({ owner: 'live', claimReceipt: 'RQ-LIVE', runningEvidence: { source: 'live-worker RQ-LIVE', at } });
    expect(classify(o).state).toBe('RUNNING');
  });
  it('reports the remaining held lane', () => {
    const o = order([merged, queued]);
    expect(orderEvidence(o, at, live, lanes).blocker).toMatchObject({ dependency: 'lane held held', source: 'slots.json' });
    expect(classify(o).state).toBe('BLOCKED');
  });
  it('reports a remaining job that ended empty', () => {
    const empty: OrderTraceJob = { ...job('RQ-EMPTY', 'launched'), endedEmptyAt: at };
    const o = order([merged, empty]);
    expect(orderEvidence(o, at).blocker).toMatchObject({ dependency: 'job RQ-EMPTY ended empty', source: 'metrics/jobs.jsonl' });
    expect(classify(o).state).toBe('BLOCKED');
  });
  it('verifies only nonempty orders whose children all have merged artifacts', () => {
    for (const jobs of [[merged], [merged, job('RQ-DONE2', 'merged', 'other', url)]]) {
      expect(orderEvidence(order(jobs), at).verified).toMatchObject({ artifact: url });
      expect(classify(order(jobs)).state).toBe('VERIFIED');
    }
    for (const jobs of [[], [merged, job('RQ-BAD', 'merged', 'other', 'https://example.com/no-pr')]]) {
      expect(orderEvidence(order(jobs), at).verified).toBeUndefined();
      expect(classify(order(jobs)).state).not.toBe('VERIFIED');
    }
  });
  it('does not change completion truth when mixed children are reordered', () => {
    for (const jobs of [[merged, queued, launched], [launched, merged, queued], [queued, launched, merged]]) {
      expect(orderEvidence(order(jobs), at, live).verified).toBeUndefined();
      expect(classify(order(jobs)).state).toBe('RUNNING');
    }
  });
});
