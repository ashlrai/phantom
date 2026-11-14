/** Mapping rows for orderEvidence/classifyOrder: the order trace may only
 * ever produce RECEIVED, ASSIGNED or VERIFIED — never RUNNING (no fresh
 * per-job timestamp in the source) and never BLOCKED (no dependency edge). */
import { describe, expect, it } from 'vitest';
import { classifyOrder, mostAdvancedJob, orderEvidence, pullRequest, type TraceOrder } from '../src/core/fleet/order-work-state.js';
import type { OrderTraceJob } from '../src/core/fleet/order-trace.js';

const GENERATED = '2026-11-13T12:00:00.000Z';
const NOW = '2026-11-13T12:00:00.000Z';
const PR_URL = 'https://github.com/ashlrai/phantom/pull/123';
// '2026-11-12 22:29' ET is 2026-11-13T03:29:00.000Z (EST, UTC-5).
const AT = '2026-11-12 22:29';
const RECEIVED_ISO = '2026-11-13T03:29:00.000Z';

const order = (jobs: OrderTraceJob[], at = AT): TraceOrder => ({ at, source: 'Phantom desktop', key: '11-12 22:29', jobs });
const job = (id: string, lane: string | null, state: OrderTraceJob['state'], url: string | null = null): OrderTraceJob => ({ id, lane, state, url });
const state = (o: TraceOrder) => classifyOrder(o, GENERATED, NOW);

describe('orderEvidence', () => {
  it('no jobs: id + receivedAt only', () => {
    expect(orderEvidence(order([]), GENERATED)).toEqual({ id: '11-12 22:29', receivedAt: RECEIVED_ISO });
  });
  it('queued: owner only from a non-null lane, never a claim receipt', () => {
    expect(orderEvidence(order([job('RQ-PHX-FAKE1', 'devin', 'queued')]), GENERATED))
      .toEqual({ id: '11-12 22:29', receivedAt: RECEIVED_ISO, owner: 'devin' });
    const e = orderEvidence(order([job('RQ-PHX-FAKE1', null, 'queued')]), GENERATED);
    expect(e.owner).toBeUndefined();
    expect(e.claimReceipt).toBeUndefined();
  });
  it('launched or published: owner + claimReceipt, url stays out of evidence', () => {
    expect(orderEvidence(order([job('RQ-PHX-FAKE1', 'devin', 'launched')]), GENERATED))
      .toEqual({ id: '11-12 22:29', receivedAt: RECEIVED_ISO, owner: 'devin', claimReceipt: 'RQ-PHX-FAKE1' });
    expect(orderEvidence(order([job('RQ-PHX-FAKE2', 'devin', 'published', PR_URL)]), GENERATED))
      .toEqual({ id: '11-12 22:29', receivedAt: RECEIVED_ISO, owner: 'devin', claimReceipt: 'RQ-PHX-FAKE2' });
  });
  it('merged: a github pull url verifies; any other url does not', () => {
    expect(orderEvidence(order([job('RQ-PHX-FAKE3', 'devin', 'merged', PR_URL)]), GENERATED).verified)
      .toEqual({ pr: 123, artifact: PR_URL, source: 'order-trace', at: GENERATED });
    expect(orderEvidence(order([job('RQ-PHX-FAKE3', 'devin', 'merged', 'https://example.test/artifacts/9')]), GENERATED).verified).toBeUndefined();
    expect(orderEvidence(order([job('RQ-PHX-FAKE3', 'devin', 'merged')]), GENERATED).verified).toBeUndefined();
  });
  it('the most advanced job wins; ties keep the trace order', () => {
    expect(mostAdvancedJob(order([job('RQ-A', 'x', 'launched'), job('RQ-B', 'x', 'queued')]))?.id).toBe('RQ-A');
    expect(mostAdvancedJob(order([job('RQ-A', 'x', 'queued'), job('RQ-B', 'x', 'merged', PR_URL)]))?.id).toBe('RQ-B');
    expect(mostAdvancedJob(order([job('RQ-A', 'x', 'merged'), job('RQ-B', 'x', 'merged', PR_URL)]))?.id).toBe('RQ-A');
    expect(mostAdvancedJob(order([]))).toBeUndefined();
  });
});

describe('classifyOrder', () => {
  it('no jobs is RECEIVED with owner and claim receipt missing', () => {
    expect(state(order([]))).toEqual({
      state: 'RECEIVED', asOf: RECEIVED_ISO, source: 'receivedAt',
      missing: ['named owner', 'durable claim receipt'],
    });
  });
  it('a queued job is still RECEIVED — a queued line is not a claim', () => {
    expect(state(order([job('RQ-PHX-FAKE1', 'devin', 'queued')])).missing).toEqual(['durable claim receipt']);
    expect(state(order([job('RQ-PHX-FAKE1', null, 'queued')])).missing).toEqual(['named owner', 'durable claim receipt']);
  });
  it('launched or published is ASSIGNED from the job id claim', () => {
    for (const s of ['launched', 'published'] as const) {
      expect(state(order([job('RQ-PHX-FAKE1', 'devin', s)]))).toEqual({
        state: 'ASSIGNED', asOf: RECEIVED_ISO, source: 'claim:RQ-PHX-FAKE1', missing: [],
      });
    }
  });
  it('a launched job with a null lane is RECEIVED with the owner missing', () => {
    const c = state(order([job('RQ-PHX-FAKE1', null, 'launched')]));
    expect(c.state).toBe('RECEIVED');
    expect(c.missing).toEqual(['named owner']);
  });
  it('merged with a github pull url is VERIFIED at the trace generation time', () => {
    expect(state(order([job('RQ-PHX-FAKE3', 'devin', 'merged', PR_URL)]))).toEqual({
      state: 'VERIFIED', asOf: GENERATED, source: 'order-trace', missing: [],
    });
  });
  it('merged with a non-PR url is ASSIGNED, never VERIFIED', () => {
    const c = state(order([job('RQ-PHX-FAKE3', 'devin', 'merged', 'https://example.test/artifacts/9')]));
    expect(c.state).toBe('ASSIGNED');
    expect(c.source).toBe('claim:RQ-PHX-FAKE3');
  });
  it('an order time the parser cannot read stays RECEIVED with as-of unknown', () => {
    const c = state(order([], 'not a time'));
    expect(c.state).toBe('RECEIVED');
    expect(c.asOf).toBe('unknown');
    expect(c.source).toBe('unknown');
  });
  it('never reports RUNNING or BLOCKED from this source', () => {
    const jobs = [
      [], [job('RQ-A', 'x', 'queued')], [job('RQ-A', null, 'queued')],
      [job('RQ-A', 'x', 'launched')], [job('RQ-A', 'x', 'published')],
      [job('RQ-A', 'x', 'published', PR_URL)], [job('RQ-A', 'x', 'merged', PR_URL)],
      [job('RQ-A', 'x', 'merged')], [job('RQ-A', 'x', 'merged', 'https://example.test/x')],
    ];
    for (const j of jobs) expect(['RECEIVED', 'ASSIGNED', 'VERIFIED']).toContain(state(order(j)).state);
  });
});

describe('pullRequest', () => {
  it('extracts the pr number only from github pull urls', () => {
    expect(pullRequest(PR_URL)).toEqual({ url: PR_URL, pr: 123 });
    expect(pullRequest(`${PR_URL}/`)).toEqual({ url: `${PR_URL}/`, pr: 123 });
    expect(pullRequest(null)).toBeNull();
    expect(pullRequest('https://github.com/ashlrai/phantom/pull/abc')).toBeNull();
    expect(pullRequest('https://github.com/ashlrai/phantom/issues/5')).toBeNull();
    expect(pullRequest('https://example.test/phantom/pull/123')).toBeNull();
    expect(pullRequest('https://github.com/ashlrai/phantom/pull/123/extra')).toBeNull();
  });
});
