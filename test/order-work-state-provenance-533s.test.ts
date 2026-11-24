import { describe, expect, it } from 'vitest';
import { classifyOrder, orderEvidence, type TraceOrder } from '../src/core/fleet/order-work-state.js';
import type { OrderTraceJob } from '../src/core/fleet/order-trace.js';

const now = '2026-11-13T18:00:00.000Z';
const generated = '2026-11-13T17:59:00.000Z';
const artifact = 'https://github.com/example/example/pull/533';
const queued: OrderTraceJob = { id: 'RQ-FAKE-A', lane: 'lane-a', state: 'queued', url: null };
const launched: OrderTraceJob = { id: 'RQ-FAKE-B', lane: 'lane-b', state: 'launched', url: null };
const published: OrderTraceJob = { id: 'RQ-FAKE-C', lane: 'lane-c', state: 'published', url: null };
const merged: OrderTraceJob = { id: 'RQ-FAKE-D', lane: 'lane-d', state: 'merged', url: artifact };
const order = (jobs: OrderTraceJob[]): TraceOrder => ({ at: '2026-11-12 22:29', source: 'fake', key: '11-12 22:29', jobs });
const live = (ids: string[], at = now) => ({ jobIds: new Set(ids), at });
const permutations = (jobs: OrderTraceJob[]): OrderTraceJob[][] => jobs.length === 0 ? [[]] :
  jobs.flatMap((job, index) => permutations(jobs.filter((_, i) => i !== index)).map(rest => [job, ...rest]));

describe('order evidence sibling provenance', () => {
  it('binds the running lane and receipt to the live launched job in every order', () => {
    for (const jobs of permutations([queued, launched, published])) {
      const o = order(jobs);
      const snapshot = live([launched.id]);
      expect(orderEvidence(o, generated, snapshot)).toMatchObject({
        owner: 'lane-b', claimReceipt: launched.id, runningEvidence: { source: `live-worker ${launched.id}`, at: now },
      });
      expect(classifyOrder(o, generated, now, snapshot)).toEqual({ state: 'RUNNING', asOf: now, source: `live-worker ${launched.id}`, missing: [] });
      for (const absent of [undefined, live([]), live([queued.id, 'RQ-FAKE-UNRELATED'])]) {
        expect(orderEvidence(o, generated, absent)).toMatchObject({ owner: 'lane-c', claimReceipt: published.id });
        expect(orderEvidence(o, generated, absent).runningEvidence).toBeUndefined();
        expect(classifyOrder(o, generated, now, absent).state).toBe('ASSIGNED');
      }
    }
  });

  it('gives a merged sibling its own receipt and artifact ahead of live evidence', () => {
    for (const jobs of permutations([queued, launched, published, merged])) {
      const o = order(jobs);
      const snapshot = live([launched.id]);
      expect(orderEvidence(o, generated, snapshot)).toMatchObject({
        owner: 'lane-d', claimReceipt: merged.id,
        verified: { pr: 533, artifact, source: 'order-trace', at: generated },
      });
      expect(orderEvidence(o, generated, snapshot).runningEvidence).toBeUndefined();
      expect(classifyOrder(o, generated, now, snapshot)).toEqual({ state: 'VERIFIED', asOf: generated, source: 'order-trace', missing: [] });
    }
  });

  it('rejects malformed merged artifacts and retains the live sibling provenance', () => {
    for (const url of [null, 'https://example.test/example/pull/533', 'https://github.com/example/example/pull/no', `${artifact}/extra`, `${artifact}?x=1`]) {
      for (const jobs of permutations([launched, { ...merged, url }])) {
        const o = order(jobs);
        const snapshot = live([launched.id]);
        expect(orderEvidence(o, generated, snapshot)).toMatchObject({ owner: 'lane-b', claimReceipt: launched.id });
        expect(orderEvidence(o, generated, snapshot).verified).toBeUndefined();
        expect(classifyOrder(o, generated, now, snapshot).state).toBe('RUNNING');
      }
    }
  });

  it('does not borrow a sibling lane when the live or merged job has no lane', () => {
    for (const jobs of permutations([published, { ...launched, lane: null }])) {
      const o = order(jobs);
      const snapshot = live([launched.id]);
      expect(orderEvidence(o, generated, snapshot)).toMatchObject({ owner: 'lane-c', claimReceipt: published.id });
      expect(orderEvidence(o, generated, snapshot).runningEvidence).toBeUndefined();
      expect(classifyOrder(o, generated, now, snapshot).state).toBe('ASSIGNED');
    }
    for (const jobs of permutations([launched, { ...merged, lane: null }])) {
      const o = order(jobs);
      const evidence = orderEvidence(o, generated, live([launched.id]));
      expect(evidence.owner).toBeUndefined();
      expect(evidence.claimReceipt).toBe(merged.id);
      expect(evidence.verified?.artifact).toBe(artifact);
      expect(classifyOrder(o, generated, now, live([launched.id])).state).toBe('VERIFIED');
    }
  });

  it('retains the selected job while stale or future snapshots fail freshness', () => {
    const o = order([published, launched]);
    for (const at of ['2026-11-13T17:29:59.000Z', '2026-11-13T18:05:01.000Z']) {
      const snapshot = live([launched.id], at);
      expect(orderEvidence(o, generated, snapshot)).toMatchObject({ owner: 'lane-b', claimReceipt: launched.id, runningEvidence: { at } });
      expect(classifyOrder(o, generated, now, snapshot)).toMatchObject({ state: 'ASSIGNED', source: `claim:${launched.id}`, missing: ['fresh running evidence'] });
    }
  });
});
