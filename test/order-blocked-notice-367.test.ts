import { describe, expect, it } from 'vitest';
import { planOrderBlockedNotices } from '../src/core/fleet/order-blocked-notice.js';
import type { OrderTraceJob, OrderTraceV1 } from '../src/core/fleet/order-trace.js';
import type { LaneTargetRow, LaneTargetsV1 } from '../src/core/fleet/runs-lane-targets.js';

const GEN = '2026-11-14T12:00:00.000Z';
const UNTIL = '2026-11-20T00:00:00Z';
const row = (lane: string, held: boolean, extra: Partial<LaneTargetRow> = {}): LaneTargetRow => ({
  lane, target: 1, floor: 0, ceiling: 4, held, heldReason: null, heldUntil: null,
  pausedFrom: null, lastChange: null, changedBy: null, ...extra,
});
const lanes = (rows: LaneTargetRow[], sourceState: LaneTargetsV1['sourceState'] = 'healthy'): LaneTargetsV1 =>
  ({ v: 1, generatedAt: GEN, sourceState, lanes: rows });
const job = (lane: string | null, state: OrderTraceJob['state'] = 'queued',
  id = 'RQ-PHX-FAKEJOB1'): OrderTraceJob => ({ id, lane, state, url: null });
type Order = OrderTraceV1['orders'][number];
const order = (jobs: OrderTraceJob[], extra: Partial<Order> = {}): Order =>
  ({ at: '2026-11-14 08:00', source: 'desktop (fake-entry-1)', key: '11-14 08:00', jobs, ...extra });
const trace = (orders: Order[]): OrderTraceV1 => ({ v: 1, generatedAt: GEN,
  sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy', queue: 'healthy' }, orders });
const held = (extra: Partial<LaneTargetRow> = {}) => lanes([row('fake-held', true, { heldUntil: UNTIL, ...extra })]);

describe('planOrderBlockedNotices', () => {
  it('plans one Blocked notice naming the held lane and its normalized hold expiry', () => {
    const notices = planOrderBlockedNotices(trace([order([job('fake-held')])]), held(), new Set());
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ channel: 'desktop', entryId: 'fake-entry-1', jobId: 'RQ-PHX-FAKEJOB1' });
    expect(notices[0]!.key).toMatch(/^fake-entry-1:blocked:[0-9a-f]{16}$/);
    expect(notices[0]!.text)
      .toBe('Blocked: your 11-14 08:00 order waits on lane fake-held held until 2026-11-20T00:00:00.000Z.');
  });

  it('plans nothing unless the lane source is healthy', () => {
    const t = trace([order([job('fake-held')])]);
    expect(planOrderBlockedNotices(t, undefined, new Set())).toEqual([]);
    expect(planOrderBlockedNotices(t, held(), new Set())).toHaveLength(1);
    for (const sourceState of ['missing', 'degraded'] as const) {
      expect(planOrderBlockedNotices(t, lanes([row('fake-held', true)], sourceState), new Set())).toEqual([]);
    }
  });

  it('skips orders that already made progress or could still dispatch', () => {
    const onHeld = held();
    const cases: OrderTraceJob[][] = [
      [job('fake-held', 'merged')],                       // verified work: no blocker
      [job('fake-held', 'launched'), job('fake-held', 'queued', 'RQ-PHX-FAKEJOB2')],
      [job('fake-held'), job('fake-held', 'merged', 'RQ-PHX-FAKEJOB2')],
      [job('free-lane')],                                 // queued on an unheld lane
      [job('ghost-lane')],                                // queued on an unknown lane
      [job(null)],                                        // queued with no lane yet
      [],                                                 // no jobs dispatched
    ];
    for (const jobs of cases) {
      const l = lanes([...onHeld.lanes, row('free-lane', false)]);
      expect(planOrderBlockedNotices(trace([order(jobs)]), l, new Set())).toEqual([]);
    }
    const unrouted = order([job('fake-held')], { source: 'Mason, desktop' });
    expect(planOrderBlockedNotices(trace([unrouted]), onHeld, new Set())).toEqual([]);
  });

  it('dedupes against the ledger set and within a single run', () => {
    const t = trace([order([job('fake-held')]), order([job('fake-held')])]);
    expect(planOrderBlockedNotices(t, held(), new Set())).toHaveLength(1);
    const [notice] = planOrderBlockedNotices(trace([order([job('fake-held')])]), held(), new Set());
    expect(planOrderBlockedNotices(trace([order([job('fake-held')])]), held(), new Set([notice!.key]))).toEqual([]);
  });

  it('keys on the lane set only: a renewed hold reuses the key, a different set does not', () => {
    const t = trace([order([job('fake-held')])]);
    const first = planOrderBlockedNotices(t, held(), new Set())[0]!.key;
    expect(planOrderBlockedNotices(t, held({ heldUntil: '2026-12-01T00:00:00Z' }), new Set())[0]!.key).toBe(first);
    const moved = planOrderBlockedNotices(trace([order([job('zeta-held')])]),
      lanes([row('zeta-held', true, { heldUntil: UNTIL })]), new Set())[0]!.key;
    expect(moved).not.toBe(first);
    const twoLane = planOrderBlockedNotices(
      trace([order([job('fake-held'), job('zeta-held', 'queued', 'RQ-PHX-FAKEJOB2')])]),
      lanes([row('fake-held', true, { heldUntil: UNTIL }), row('zeta-held', true)]), new Set());
    expect(twoLane[0]!.key).not.toBe(first);
    expect(twoLane[0]!.text).toContain('lane fake-held held until 2026-11-20T00:00:00.000Z, lane zeta-held held');
  });

  it('routes extra channels with a channel-suffixed key, like merge notices', () => {
    const o = order([job('fake-held')], { alsoChannels: ['telegram', 'telegram', 'desktop'] });
    const notices = planOrderBlockedNotices(trace([o]), held(), new Set());
    expect(notices.map((n) => n.channel)).toEqual(['desktop', 'telegram']);
    expect(notices[0]!.key).toMatch(/^fake-entry-1:blocked:[0-9a-f]{16}$/);
    expect(notices[1]!.key).toBe(`${notices[0]!.key}:telegram`);
    expect(planOrderBlockedNotices(trace([o]), held(), new Set([notices[0]!.key])))
      .toEqual([notices[1]]);
  });

  it('never carries hold reasons or attribution and caps scrubbed text at 200', () => {
    const secretLanes = lanes([row('fake-held', true, {
      heldReason: 'MARKER-fake-hold-reason', heldUntil: UNTIL, changedBy: 'MARKER-fake-operator',
    })]);
    const notices = planOrderBlockedNotices(trace([order([job('fake-held')])]), secretLanes, new Set());
    expect(JSON.stringify(notices)).not.toContain('MARKER');
    const long = order([job('fake-held')], { key: `key-${'x'.repeat(300)}` });
    expect(planOrderBlockedNotices(trace([long]), held(), new Set())[0]!.text).toHaveLength(200);
  });
});
