import { describe, expect, it } from 'vitest';
import { heldLaneBlocker } from '../src/core/fleet/order-lane-blocker.js';
import { classifyOrder, type TraceOrder } from '../src/core/fleet/order-work-state.js';
import type { OrderTraceJob } from '../src/core/fleet/order-trace.js';
import type { LaneTargetRow, LaneTargetsV1 } from '../src/core/fleet/runs-lane-targets.js';

const GEN = '2026-01-02T03:00:00.000Z';
const NOW = '2026-01-02T03:05:00.000Z';
const UNTIL = '2026-01-03T00:00:00.000Z';
const row = (lane: string, held: boolean, extra: Partial<LaneTargetRow> = {}): LaneTargetRow => ({
  lane, target: 1, floor: 0, ceiling: 4, held, heldReason: null, heldUntil: null,
  pausedFrom: null, lastChange: null, changedBy: null, ...extra,
});
const lanes = (rows: LaneTargetRow[], sourceState: LaneTargetsV1['sourceState'] = 'healthy'): LaneTargetsV1 => ({ v: 1, generatedAt: GEN, sourceState, lanes: rows });
const job = (lane: string | null, state: OrderTraceJob['state'] = 'queued', id = 'RQ-PHX-FAKEJOB1', url: string | null = null): OrderTraceJob => ({ id, lane, state, url });
const order = (jobs: OrderTraceJob[]): TraceOrder => ({ at: '2026-01-01 10:00', source: 'Phantom desktop', key: 'fake-order', jobs });

describe('heldLaneBlocker', () => {
  it('names the held lane and its hold expiry when the only job is queued there', () => {
    const o = order([job('fake-lane')]);
    const l = lanes([row('fake-lane', true, { heldUntil: UNTIL })]);
    expect(heldLaneBlocker(o, l)).toEqual({ dependency: `lane fake-lane held until ${UNTIL}`, source: 'slots.json', at: GEN });
    expect(classifyOrder(o, GEN, NOW, undefined, l)).toEqual({ state: 'BLOCKED', asOf: GEN, source: 'slots.json', missing: [] });
  });

  it('never carries the hold reason or an unparseable expiry', () => {
    const o = order([job('fake-lane')]);
    const l = lanes([row('fake-lane', true, { heldReason: 'usage reset for fake-account@example.invalid', heldUntil: 'whenever fake-account resets' })]);
    const blocker = heldLaneBlocker(o, l);
    expect(blocker?.dependency).toBe('lane fake-lane held');
    expect(JSON.stringify(blocker)).not.toContain('fake-account');
  });

  it('is undefined when any queued job sits on an unheld lane', () => {
    const o = order([job('fake-lane'), job('free-lane', 'queued', 'RQ-PHX-FAKEJOB2')]);
    expect(heldLaneBlocker(o, lanes([row('fake-lane', true), row('free-lane', false)]))).toBeUndefined();
  });

  it('is undefined for an unknown lane', () => {
    expect(heldLaneBlocker(order([job('ghost-lane')]), lanes([row('fake-lane', true)]))).toBeUndefined();
  });

  it('is undefined when a job has launched, even on a held lane', () => {
    const o = order([job('fake-lane'), job('fake-lane', 'launched', 'RQ-PHX-FAKEJOB2')]);
    const l = lanes([row('fake-lane', true)]);
    expect(heldLaneBlocker(o, l)).toBeUndefined();
    expect(classifyOrder(o, GEN, NOW, undefined, l).state).toBe('ASSIGNED');
  });

  it('keeps a merged order with a PR url VERIFIED when its lane is held', () => {
    const url = 'https://github.com/fake-org/fake-repo/pull/7';
    const o = order([job('fake-lane', 'merged', 'RQ-PHX-FAKEJOB1', url), job('fake-lane', 'queued', 'RQ-PHX-FAKEJOB2')]);
    const l = lanes([row('fake-lane', true, { heldUntil: UNTIL })]);
    expect(heldLaneBlocker(o, l)).toBeUndefined();
    expect(classifyOrder(o, GEN, NOW, undefined, l).state).toBe('VERIFIED');
  });

  it('is undefined unless the lane source is healthy', () => {
    const o = order([job('fake-lane')]);
    expect(heldLaneBlocker(o, lanes([row('fake-lane', true)], 'degraded'))).toBeUndefined();
    expect(heldLaneBlocker(o, lanes([row('fake-lane', true)], 'missing'))).toBeUndefined();
    expect(heldLaneBlocker(o, undefined)).toBeUndefined();
    expect(classifyOrder(o, GEN, NOW).state).toBe('RECEIVED');
  });

  it('is undefined for a job with no lane or an order with no jobs', () => {
    expect(heldLaneBlocker(order([job(null)]), lanes([row('fake-lane', true)]))).toBeUndefined();
    expect(heldLaneBlocker(order([]), lanes([row('fake-lane', true)]))).toBeUndefined();
  });

  it('names several held lanes sorted', () => {
    const o = order([job('zeta-lane'), job('alpha-lane', 'queued', 'RQ-PHX-FAKEJOB2'), job('zeta-lane', 'queued', 'RQ-PHX-FAKEJOB3')]);
    const l = lanes([row('zeta-lane', true), row('alpha-lane', true, { heldUntil: UNTIL })]);
    expect(heldLaneBlocker(o, l)?.dependency).toBe(`lane alpha-lane held until ${UNTIL}, lane zeta-lane held`);
  });
});
