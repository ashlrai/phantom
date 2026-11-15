import { describe, expect, it } from 'vitest';
import { planOrderBlockedNotices } from '../src/core/fleet/order-blocked-notice.js';
import type { OrderTraceJob, OrderTraceV1 } from '../src/core/fleet/order-trace.js';
import type { LaneTargetRow, LaneTargetsV1 } from '../src/core/fleet/runs-lane-targets.js';

const GEN = '2026-11-15T00:00:00.000Z';
const UNTIL = '2026-11-22T00:00:00Z';

const row = (lane: string, held: boolean, extra: Partial<LaneTargetRow> = {}): LaneTargetRow => ({
  lane, target: 1, floor: 0, ceiling: 4, held, heldReason: null, heldUntil: null,
  pausedFrom: null, lastChange: null, changedBy: null, ...extra,
});
const lanes = (rows: LaneTargetRow[]): LaneTargetsV1 =>
  ({ v: 1, generatedAt: GEN, sourceState: 'healthy', lanes: rows });
const job = (lane: string | null, state: OrderTraceJob['state'] = 'queued',
  id: string): OrderTraceJob => ({ id, lane, state, url: null });
type Order = OrderTraceV1['orders'][number];
const order = (jobs: OrderTraceJob[], extra: Partial<Order> = {}): Order =>
  ({ at: '2026-11-15 02:00', source: 'slack (fake-thread-9)', key: '11-15 02:00', jobs, ...extra });
const trace = (orders: Order[]): OrderTraceV1 => ({ v: 1, generatedAt: GEN,
  sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy', queue: 'healthy' }, orders });

describe('planOrderBlockedNotices (recut c407)', () => {
  it('selects only the blocked order out of a mixed trace and names its first queued job', () => {
    const heldLanes = lanes([row('held-lane', true, { heldUntil: UNTIL }), row('open-lane', false)]);
    const t = trace([
      order([job('held-lane', 'queued', 'RQ-PHX-BLOCKED1')], { source: 'slack (fake-thread-9)' }),
      order([job('held-lane', 'merged', 'RQ-PHX-DONE2')], { source: 'desktop (fake-entry-2)', key: '11-15 02:01' }),
      order([job('open-lane', 'queued', 'RQ-PHX-FREE3')], { source: 'desktop (fake-entry-3)', key: '11-15 02:02' }),
    ]);
    const notices = planOrderBlockedNotices(t, heldLanes, new Set());
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ channel: 'slack', entryId: 'fake-thread-9', jobId: 'RQ-PHX-BLOCKED1' });
    expect(notices[0]!.key).toMatch(/^fake-thread-9:blocked:[0-9a-f]{16}$/);
    expect(notices[0]!.text).toBe('Blocked: your 11-15 02:00 order waits on lane held-lane held until 2026-11-22T00:00:00.000Z.');
  });

  it('notifies each blocked order separately even on the same held lane', () => {
    const heldLanes = lanes([row('held-lane', true, { heldUntil: UNTIL })]);
    const t = trace([
      order([job('held-lane', 'queued', 'RQ-PHX-ONE1')], { source: 'desktop (fake-entry-a)' }),
      order([job('held-lane', 'queued', 'RQ-PHX-TWO2')], { source: 'desktop (fake-entry-b)', key: '11-15 02:03' }),
    ]);
    const notices = planOrderBlockedNotices(t, heldLanes, new Set());
    expect(notices).toHaveLength(2);
    expect(new Set(notices.map((n) => n.key)).size).toBe(2);
    // A ledger key recorded for the first order does not suppress the second.
    expect(planOrderBlockedNotices(t, heldLanes, new Set([notices[0]!.key])))
      .toEqual([notices[1]]);
  });

  it('plans nothing for an order whose queued jobs are split between held and free lanes', () => {
    const heldLanes = lanes([row('held-lane', true, { heldUntil: UNTIL }), row('open-lane', false)]);
    const t = trace([order([
      job('held-lane', 'queued', 'RQ-PHX-HELD4'),
      job('open-lane', 'queued', 'RQ-PHX-OPEN5'),
    ])]);
    expect(planOrderBlockedNotices(t, heldLanes, new Set())).toEqual([]);
  });

  it('keys notices on the full held-lane set of the order, not the union of held lanes', () => {
    const heldLanes = lanes([row('held-a', true, { heldUntil: UNTIL }), row('held-b', true)]);
    const bothQueued = order([
      job('held-a', 'queued', 'RQ-PHX-A6'),
      job('held-b', 'queued', 'RQ-PHX-B7'),
    ]);
    const onlyA = order([job('held-a', 'queued', 'RQ-PHX-A8')], { source: 'desktop (fake-entry-c)', key: '11-15 02:04' });
    const keyBoth = planOrderBlockedNotices(trace([bothQueued]), heldLanes, new Set())[0]!.key;
    const keyOnlyA = planOrderBlockedNotices(trace([onlyA]), heldLanes, new Set())[0]!.key;
    expect(keyBoth).not.toBe(keyOnlyA);
  });
});
